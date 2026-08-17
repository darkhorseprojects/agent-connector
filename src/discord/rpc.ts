export type DiscordContext = Readonly<{
  actor: string;
  policy: string;
  userId: string;
  messageId: string;
  channelId: string;
  parentChannelId?: string;
  guildId?: string;
}>;

type RestOptions = Readonly<{
  body?: unknown;
  query?: URLSearchParams;
  reason?: string;
  files?: readonly Readonly<{ data: Uint8Array; name: string; contentType?: string }>[];
}>;

export type DiscordRest = Readonly<{
  get(route: string, options?: RestOptions): Promise<unknown>;
  post(route: string, options?: RestOptions): Promise<unknown>;
  put(route: string, options?: RestOptions): Promise<unknown>;
  patch(route: string, options?: RestOptions): Promise<unknown>;
  delete(route: string, options?: RestOptions): Promise<unknown>;
}>;

export type DiscordCapability = Readonly<{
  environment: Readonly<Record<string, string>>;
  revoke(): void;
}>;

export class DiscordRpcServer {
  readonly #rest: DiscordRest;
  readonly #maximumBytes: number;
  readonly #grants = new Map<string, DiscordContext>();
  readonly #server: Deno.HttpServer;
  readonly #url: string;

  constructor(rest: DiscordRest, maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError("maximumBytes must be positive");
    }
    this.#rest = rest;
    this.#maximumBytes = maximumBytes;
    this.#server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      (request) => this.#handle(request),
    );
    this.#url = `http://127.0.0.1:${(this.#server.addr as Deno.NetAddr).port}`;
  }

  grant(context: DiscordContext): DiscordCapability {
    const token = randomToken();
    this.#grants.set(token, Object.freeze({ ...context }));
    let active = true;
    return Object.freeze({
      environment: Object.freeze({
        AGENT_CONNECTOR_DISCORD_URL: this.#url,
        AGENT_CONNECTOR_DISCORD_TOKEN: token,
      }),
      revoke: () => {
        if (active) {
          active = false;
          this.#grants.delete(token);
        }
      },
    });
  }

  async close(): Promise<void> {
    this.#grants.clear();
    await this.#server.shutdown();
  }

  async #handle(request: Request): Promise<Response> {
    const context = this.#authorize(request);
    if (!context) return response(401, { error: "unauthorized" }, this.#maximumBytes);
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/v1/context") {
        return response(200, context, this.#maximumBytes);
      }
      if (request.method !== "POST" || url.pathname !== "/v1/request") {
        return response(404, { error: "not found" }, this.#maximumBytes);
      }
      const rawLength = request.headers.get("content-length");
      if (rawLength === null || !/^\d+$/.test(rawLength)) {
        return response(411, { error: "content-length is required" }, this.#maximumBytes);
      }
      const length = Number(rawLength);
      if (!Number.isSafeInteger(length) || length > this.#maximumBytes) {
        return response(413, { error: "request exceeds configured byte limit" }, this.#maximumBytes);
      }
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.length !== length) {
        return response(400, { error: "request length is invalid" }, this.#maximumBytes);
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        return response(400, { error: "invalid JSON" }, this.#maximumBytes);
      }
      return response(200, { value: await this.#request(value) ?? null }, this.#maximumBytes);
    } catch (error) {
      return response(error instanceof RequestError ? 400 : 502, {
        error: error instanceof Error ? error.message : String(error),
      }, this.#maximumBytes);
    }
  }

  #authorize(request: Request): DiscordContext | undefined {
    const authorization = request.headers.get("authorization");
    return authorization?.startsWith("Bearer ") ? this.#grants.get(authorization.slice(7)) : undefined;
  }

  async #request(value: unknown): Promise<unknown> {
    const request = object(value, "request");
    exact(request, ["method", "route", "query", "body", "reason", "files"]);
    const method = text(request.method, "method").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new RequestError("unsupported method");
    const route = text(request.route, "route");
    if (!route.startsWith("/") || route.startsWith("//") || route.includes("://")) {
      throw new RequestError("route must be a Discord REST path");
    }
    const options: { body?: unknown; query?: URLSearchParams; reason?: string; files?: RestOptions["files"] } = {};
    if (request.body !== undefined) options.body = request.body;
    if (request.query !== undefined) options.query = query(request.query);
    if (request.reason !== undefined) {
      const reason = text(request.reason, "reason");
      if (reason.length > 512 || /[\r\n]/.test(reason)) throw new RequestError("reason is invalid");
      options.reason = reason;
    }
    if (request.files !== undefined) options.files = files(request.files);
    if (method === "GET") return await this.#rest.get(route, options);
    if (method === "POST") return await this.#rest.post(route, options);
    if (method === "PUT") return await this.#rest.put(route, options);
    if (method === "PATCH") return await this.#rest.patch(route, options);
    return await this.#rest.delete(route, options);
  }
}

class RequestError extends Error {}

function response(status: number, value: unknown, maximumBytes: number): Response {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.length > maximumBytes) {
    const failure = new TextEncoder().encode(JSON.stringify({ error: "response exceeds configured byte limit" }));
    return new Response(failure.length <= maximumBytes ? failure : null, {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new RequestError(`unknown request key: ${key}`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new RequestError(`${name} must be nonempty text without NUL`);
  }
  return value;
}

function query(value: unknown): URLSearchParams {
  const result = new URLSearchParams();
  for (const [name, item] of Object.entries(object(value, "query"))) {
    for (const part of Array.isArray(item) ? item : [item]) result.append(name, scalar(part, `query.${name}`));
  }
  return result;
}

function scalar(value: unknown, name: string): string {
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  throw new RequestError(`${name} must contain scalar values`);
}

function files(value: unknown): RestOptions["files"] {
  if (!Array.isArray(value)) throw new RequestError("files must be an array");
  return value.map((item, index) => {
    const file = object(item, `files[${index}]`);
    exact(file, ["name", "data", "contentType"]);
    let data: Uint8Array;
    try {
      data = Uint8Array.fromBase64(text(file.data, `files[${index}].data`));
    } catch {
      throw new RequestError(`files[${index}].data is not base64`);
    }
    return {
      data,
      name: text(file.name, `files[${index}].name`),
      contentType: file.contentType === undefined ? undefined : text(file.contentType, `files[${index}].contentType`),
    };
  });
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
