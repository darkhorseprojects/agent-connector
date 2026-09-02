import { Schema } from "effect";

export type DiscordContext = Readonly<{
  actor: string;
  policy: string;
  userId: string;
  messageId: string;
  messageChannelId: string;
  channelId: string;
  parentChannelId?: string;
  guildId?: string;
}>;
type RestOptions = Readonly<{
  body?: unknown;
  query?: URLSearchParams;
  files?: readonly Readonly<{ data: Uint8Array; name: string; contentType?: string }>[];
}>;
type Method = "get" | "post" | "put" | "patch" | "delete";
export type DiscordRest = Readonly<Record<Method, (route: string, options?: RestOptions) => Promise<unknown>>>;
export type DiscordCapability = Readonly<{ environment: Readonly<Record<string, string>>; revoke(): void }>;
type Grant = { context: DiscordContext; owned: Set<string> };
class RequestError extends Error {}

const Id = Schema.String.check(Schema.isPattern(/^\d{17,20}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/));
const File = Schema.Struct({ name: Text, data: Text, contentType: Schema.optional(Text) });
const Limit = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }));
const Request = Schema.Union([
  Schema.Struct({ type: Schema.Literal("listMessages"), limit: Schema.optional(Limit), before: Schema.optional(Id) }),
  Schema.Struct({ type: Schema.Literal("getMessage"), message: Id }),
  Schema.Struct({
    type: Schema.Literal("createMessage"),
    content: Schema.optional(Text),
    files: Schema.optional(Schema.Array(File)),
  }),
  Schema.Struct({ type: Schema.Literal("editMessage"), message: Id, content: Text }),
  Schema.Struct({ type: Schema.Literal("deleteMessage"), message: Id }),
  Schema.Struct({ type: Schema.Literal("addReaction"), message: Id, emoji: Text }),
  Schema.Struct({ type: Schema.Literal("removeReaction"), message: Id, emoji: Text }),
]);
type RpcRequest = Schema.Schema.Type<typeof Request>;
const decode = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" });

export class DiscordRpcServer {
  readonly #grants = new Map<string, Grant>();
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
    const token = crypto.getRandomValues(new Uint8Array(32)).toHex();
    this.#grants.set(token, { context: Object.freeze({ ...context }), owned: new Set() });
    return Object.freeze({
      environment: Object.freeze({
        AGENT_CONNECTOR_DISCORD_URL: this.#url,
        AGENT_CONNECTOR_DISCORD_TOKEN: token,
        AGENT_CONNECTOR_DISCORD_CONTEXT: JSON.stringify(context),
      }),
      revoke: () => this.#grants.delete(token),
    });
  }

  async close(): Promise<void> {
    this.#grants.clear();
    await this.#server.shutdown();
  }

  async #handle(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization");
    const grant = authorization?.startsWith("Bearer ") ? this.#grants.get(authorization.slice(7)) : undefined;
    if (!grant) return reply(401, { error: "unauthorized" }, this.maximumBytes);
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
      const bytes = await body(request, length);
      let value: RpcRequest;
      try {
        value = decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      } catch (error) {
        throw new RequestError(String(error));
      }
      return reply(200, await this.#request(grant, value) ?? null, this.maximumBytes);
    } catch (error) {
      return reply(error instanceof RequestError ? 400 : 502, {
        error: error instanceof Error ? error.message : String(error),
      }, this.maximumBytes);
    }
  }

  async #request(grant: Grant, request: RpcRequest): Promise<unknown> {
    const channel = `/channels/${grant.context.channelId}`;
    switch (request.type) {
      case "listMessages": {
        const query = new URLSearchParams({ limit: String(request.limit ?? 50) });
        if (request.before) query.set("before", request.before);
        return await this.rest.get(`${channel}/messages`, { query });
      }
      case "getMessage":
        return await this.rest.get(`${channel}/messages/${request.message}`);
      case "createMessage": {
        const files = decodeFiles(request.files ?? [], this.maximumBytes);
        if (!request.content && !files.length) throw new RequestError("message content or files are required");
        const attachments = files.map((file, id) => ({ id, filename: file.name }));
        const result = await this.rest.post(`${channel}/messages`, {
          body: { content: request.content, attachments, allowed_mentions: { parse: [] } },
          files,
        });
        const id = result && typeof result === "object" && "id" in result ? String(result.id) : "";
        if (!/^\d{17,20}$/.test(id)) throw new Error("Discord create response has no message id");
        grant.owned.add(id);
        return result;
      }
      case "editMessage":
        owned(grant, request.message);
        return await this.rest.patch(`${channel}/messages/${request.message}`, {
          body: { content: request.content, allowed_mentions: { parse: [] } },
        });
      case "deleteMessage":
        owned(grant, request.message);
        grant.owned.delete(request.message);
        return await this.rest.delete(`${channel}/messages/${request.message}`);
      case "addReaction":
      case "removeReaction": {
        if (request.message !== grant.context.messageId && !grant.owned.has(request.message)) {
          throw new RequestError("message is outside this grant");
        }
        const target = request.message === grant.context.messageId ? grant.context.messageChannelId : grant.context.channelId;
        const route = `/channels/${target}/messages/${request.message}/reactions/${encodeURIComponent(request.emoji)}/@me`;
        return request.type === "addReaction" ? await this.rest.put(route) : await this.rest.delete(route);
      }
    }
  }
}

async function body(request: Request, expected: number): Promise<Uint8Array> {
  if (!request.body) return expected === 0 ? new Uint8Array() : Promise.reject(new RequestError("request body is missing"));
  const result = new Uint8Array(expected);
  let offset = 0;
  for await (const chunk of request.body) {
    if (offset + chunk.length > expected) throw new RequestError("request length is invalid");
    result.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== expected) throw new RequestError("request length is invalid");
  return result;
}

function decodeFiles(
  input: readonly Schema.Schema.Type<typeof File>[],
  maximum: number,
): NonNullable<RestOptions["files"]> {
  let bytes = 0;
  return input.map((file) => {
    let data: Uint8Array;
    try {
      data = Uint8Array.fromBase64(file.data);
    } catch {
      throw new RequestError("file data is not base64");
    }
    bytes += data.length;
    if (bytes > maximum) throw new RequestError("attachments exceed configured byte limit");
    if (/[/\\\0]/.test(file.name)) throw new RequestError("file name is invalid");
    return file.contentType ? { data, name: file.name, contentType: file.contentType } : { data, name: file.name };
  });
}
function owned(grant: Grant, message: string): void {
  if (!grant.owned.has(message)) throw new RequestError("message is outside this grant");
}
function reply(status: number, value: unknown, maximum: number): Response {
  let bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > maximum) {
    status = 502;
    bytes = new TextEncoder().encode('{"error":"response exceeds configured byte limit"}');
  }
  return new Response(bytes.length <= maximum ? bytes : null, {
    status,
    headers: { "content-type": "application/json" },
  });
}
