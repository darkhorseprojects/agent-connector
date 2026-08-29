import { Schema } from "effect";

export type DiscordContext = Readonly<
  {
    actor: string;
    policy: string;
    userId: string;
    messageId: string;
    channelId: string;
    parentChannelId?: string;
    guildId?: string;
  }
>;
type RestOptions = Readonly<
  {
    body?: unknown;
    query?: URLSearchParams;
    reason?: string;
    files?: readonly Readonly<{ data: Uint8Array; name: string; contentType?: string }>[];
  }
>;
type Method = "get" | "post" | "put" | "patch" | "delete";
export type DiscordRest = Readonly<Record<Method, (route: string, options?: RestOptions) => Promise<unknown>>>;
export type DiscordCapability = Readonly<{ environment: Readonly<Record<string, string>>; revoke(): void }>;

const Text = Schema.String.pipe(Schema.minLength(1), Schema.pattern(/^[^\0]+$/));
const RequestSchema = Schema.Struct({
  method: Text,
  route: Text,
  query: Schema.optional(Schema.Unknown),
  body: Schema.optional(Schema.Unknown),
  reason: Schema.optional(Text),
  files: Schema.optional(Schema.Unknown),
});
const FileSchema = Schema.Struct({ name: Text, data: Text, contentType: Schema.optional(Text) });
const decodeRequest = Schema.decodeUnknownSync(RequestSchema, { onExcessProperty: "error" });
const decodeFile = Schema.decodeUnknownSync(FileSchema, { onExcessProperty: "error" });

export class DiscordRpcServer {
  readonly #grants = new Set<string>();
  readonly #server: Deno.HttpServer;
  readonly #url: string;
  constructor(readonly rest: DiscordRest, readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new RangeError("maximumBytes must be positive");
    this.#server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      (request) => this.#handle(request),
    );
    this.#url = `http://127.0.0.1:${(this.#server.addr as Deno.NetAddr).port}`;
  }
  grant(context: DiscordContext): DiscordCapability {
    const token = randomToken();
    this.#grants.add(token);
    let active = true;
    return Object.freeze({
      environment: Object.freeze({
        AGENT_CONNECTOR_DISCORD_URL: this.#url,
        AGENT_CONNECTOR_DISCORD_TOKEN: token,
        AGENT_CONNECTOR_DISCORD_CONTEXT: JSON.stringify(context),
        AGENT_CONNECTOR_FRAME_BYTES: String(this.maximumBytes),
      }),
      revoke: () => {
        if (active) this.#grants.delete(token);
        active = false;
      },
    });
  }
  async close(): Promise<void> {
    this.#grants.clear();
    await this.#server.shutdown();
  }
  async #handle(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || !this.#grants.has(authorization.slice(7))) {
      return reply(401, { error: "unauthorized" }, this.maximumBytes);
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/request") {
      return reply(404, { error: "not found" }, this.maximumBytes);
    }
    const raw = request.headers.get("content-length");
    if (!raw || !/^\d+$/.test(raw)) return reply(411, { error: "content-length is required" }, this.maximumBytes);
    const length = Number(raw);
    if (!Number.isSafeInteger(length) || length > this.maximumBytes) {
      return reply(413, { error: "request exceeds configured byte limit" }, this.maximumBytes);
    }
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length !== length) throw new RequestError("request length is invalid");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return reply(200, await this.#request(value) ?? null, this.maximumBytes);
    } catch (error) {
      return reply(error instanceof RequestError || error instanceof SyntaxError ? 400 : 502, {
        error: error instanceof Error ? error.message : String(error),
      }, this.maximumBytes);
    }
  }
  async #request(value: unknown): Promise<unknown> {
    let request: Schema.Schema.Type<typeof RequestSchema>;
    try {
      request = decodeRequest(value);
    } catch {
      throw new RequestError("request structure is invalid");
    }
    const method = request.method.toLowerCase() as Method;
    if (!["get", "post", "put", "patch", "delete"].includes(method)) throw new RequestError("unsupported method");
    const options: { body?: unknown; query?: URLSearchParams; reason?: string; files?: RestOptions["files"] } = {};
    if (request.body !== undefined) options.body = request.body;
    if (request.query !== undefined) options.query = query(request.query);
    if (request.reason !== undefined) {
      if (request.reason.length > 512 || /[\r\n]/.test(request.reason)) throw new RequestError("reason is invalid");
      options.reason = request.reason;
    }
    if (request.files !== undefined) options.files = files(request.files);
    return await this.rest[method](route(request.route), options);
  }
}
class RequestError extends Error {}

function reply(status: number, value: unknown, maximum: number): Response {
  let bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > maximum) {
    status = 502;
    bytes = new TextEncoder().encode(JSON.stringify({ error: "response exceeds configured byte limit" }));
  }
  return new Response(bytes.length <= maximum ? bytes : null, {
    status,
    headers: { "content-type": "application/json" },
  });
}
function route(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") || value.includes("\\") || control(value)) {
    throw new RequestError("route must be a Discord REST path");
  }
  for (const raw of value.slice(1).split("/")) {
    if (!raw) throw new RequestError("route escapes the Discord REST path");
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      throw new RequestError("route contains invalid encoding");
    }
    if (
      [".", ".."].includes(part) || part.includes("/") || part.includes("\\") || part.includes("?") ||
      part.includes("#") || control(part)
    ) {
      throw new RequestError("route escapes the Discord REST path");
    }
  }
  return value;
}
function control(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}
function query(value: unknown): URLSearchParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError("query must be an object");
  const result = new URLSearchParams();
  for (const [name, item] of Object.entries(value)) {
    for (const part of Array.isArray(item) ? item : [item]) {
      if (!["string", "number", "boolean"].includes(typeof part)) {
        throw new RequestError(`query.${name} must contain scalar values`);
      }
      result.append(name, String(part));
    }
  }
  return result;
}
function files(value: unknown): RestOptions["files"] {
  if (!Array.isArray(value)) throw new RequestError("files must be an array");
  return value.map((item, index) => {
    let file: Schema.Schema.Type<typeof FileSchema>;
    try {
      file = decodeFile(item);
      return { data: Uint8Array.fromBase64(file.data), name: file.name, contentType: file.contentType };
    } catch {
      throw new RequestError(`files[${index}] is invalid`);
    }
  });
}
function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((value) => value.toString(16).padStart(2, "0")).join("");
}
