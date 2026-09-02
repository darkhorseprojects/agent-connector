import { Schema } from "effect";

type ContextField = "actor" | "policy" | "userId" | "messageId" | "messageChannelId" | "channelId";
export type DiscordContext = Readonly<
  Record<ContextField, string> & Partial<Record<"parentChannelId" | "guildId", string>>
>;
type RestFile = Readonly<{ data: Uint8Array; name: string; contentType?: string }>;
type RestOptions = Readonly<{ body?: unknown; query?: URLSearchParams; files?: readonly RestFile[] }>;
type Method = "get" | "post" | "put" | "patch" | "delete";
export type DiscordRest = Readonly<Record<Method, (route: string, options?: RestOptions) => Promise<unknown>>>;
type Grant = { active: boolean; context: DiscordContext; owned: Set<string> };
class RequestError extends Error {}

const Id = Schema.String.check(Schema.isPattern(/^\d{17,20}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/));
const Content = Text.check(Schema.isMaxLength(2000));
const File = Schema.Struct({ name: Text, data: Text, contentType: Schema.optional(Text) });
const Limit = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }));
const Request = Schema.Union([
  Schema.Struct({ type: Schema.Literal("listMessages"), limit: Schema.optional(Limit), before: Schema.optional(Id) }),
  Schema.Struct({ type: Schema.Literal("getMessage"), message: Id }),
  Schema.Struct({
    type: Schema.Literal("createMessage"),
    content: Schema.optional(Content),
    files: Schema.optional(Schema.Array(File)),
  }),
  Schema.Struct({ type: Schema.Literal("editMessage"), message: Id, content: Content }),
  Schema.Struct({ type: Schema.Literal("deleteMessage"), message: Id }),
  Schema.Struct({ type: Schema.Literal("addReaction"), message: Id, emoji: Text }),
  Schema.Struct({ type: Schema.Literal("removeReaction"), message: Id, emoji: Text }),
]);
type RpcRequest = Schema.Schema.Type<typeof Request>;
const decode = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" });
const encoder = new TextEncoder();
const validLimit = (value?: number) => value === undefined || Number.isSafeInteger(value) && value > 0;

export class DiscordRpcServer {
  readonly #grants = new Map<string, Grant>();
  readonly #server: Deno.HttpServer;
  readonly #url: string;

  constructor(readonly rest: DiscordRest, readonly maximumBytes?: number, readonly timeoutMs?: number) {
    if (!validLimit(maximumBytes) || !validLimit(timeoutMs)) throw new RangeError("RPC limit must be positive");
    this.#server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      (request) => this.#handle(request),
    );
    this.#url = `http://127.0.0.1:${(this.#server.addr as Deno.NetAddr).port}`;
  }

  grant(context: DiscordContext) {
    const token = crypto.getRandomValues(new Uint8Array(32)).toHex();
    const grant: Grant = { active: true, context: Object.freeze({ ...context }), owned: new Set() };
    this.#grants.set(token, grant);
    const callLimits = {
      timeout_ms: this.timeoutMs,
      request_bytes: this.maximumBytes,
      response_bytes: this.maximumBytes,
    };
    return Object.freeze({
      environment: Object.freeze({
        AGENT_CONNECTOR_DISCORD_URL: this.#url,
        AGENT_CONNECTOR_DISCORD_TOKEN: token,
        AGENT_CONNECTOR_DISCORD_CONTEXT: JSON.stringify(grant.context),
        AGENT_CONNECTOR_DISCORD_LIMITS: JSON.stringify(callLimits),
      }),
      revoke: () => {
        grant.active = false;
        this.#grants.delete(token);
      },
    });
  }

  async close(): Promise<void> {
    for (const grant of this.#grants.values()) grant.active = false;
    this.#grants.clear();
    await this.#server.shutdown();
  }

  async #handle(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization");
    const grant = authorization?.startsWith("Bearer ") ? this.#grants.get(authorization.slice(7)) : undefined;
    if (!grant?.active) return reply(401, { error: "unauthorized" }, this.maximumBytes);
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/request") {
      return reply(404, { error: "not found" }, this.maximumBytes);
    }
    const raw = request.headers.get("content-length");
    if (!raw || !/^\d+$/.test(raw)) return reply(411, { error: "content-length is required" }, this.maximumBytes);
    const length = Number(raw);
    if (!Number.isSafeInteger(length) || this.maximumBytes !== undefined && length > this.maximumBytes) {
      return reply(413, { error: "request exceeds byte limit" }, this.maximumBytes);
    }
    try {
      const bytes = await body(request, length);
      let value: RpcRequest;
      try {
        value = decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      } catch (error) {
        throw new RequestError(String(error));
      }
      if (!grant.active) throw new RequestError("grant is revoked");
      return reply(200, await this.#request(grant, value), this.maximumBytes);
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
        return { id };
      }
      case "editMessage":
      case "deleteMessage": {
        owned(grant, request.message);
        const route = `${channel}/messages/${request.message}`;
        if (request.type === "editMessage") {
          await this.rest.patch(route, { body: { content: request.content, allowed_mentions: { parse: [] } } });
        } else {
          await this.rest.delete(route);
          grant.owned.delete(request.message);
        }
        return true;
      }
      case "addReaction":
      case "removeReaction": {
        if (request.message !== grant.context.messageId && !grant.owned.has(request.message)) {
          throw new RequestError("message is outside this grant");
        }
        const target = request.message === grant.context.messageId
          ? grant.context.messageChannelId
          : grant.context.channelId;
        const route = `/channels/${target}/messages/${request.message}/reactions/${
          encodeURIComponent(request.emoji)
        }/@me`;
        if (request.type === "addReaction") await this.rest.put(route);
        else await this.rest.delete(route);
        return true;
      }
    }
  }
}

async function body(request: Request, expected: number): Promise<Uint8Array> {
  const result = new Uint8Array(await request.arrayBuffer());
  if (result.length !== expected) throw new RequestError("request length is invalid");
  return result;
}
function decodeFiles(
  input: readonly Schema.Schema.Type<typeof File>[],
  maximum?: number,
): NonNullable<RestOptions["files"]> {
  if (input.length > 10) throw new RequestError("too many attachments");
  let bytes = 0;
  return input.map((file) => {
    let data: Uint8Array;
    try {
      data = Uint8Array.fromBase64(file.data);
    } catch {
      throw new RequestError("file data is not base64");
    }
    bytes += data.length;
    if (maximum !== undefined && bytes > maximum) throw new RequestError("attachments exceed configured byte limit");
    if (/[/\\\0\r\n]/.test(file.name)) throw new RequestError("file name is invalid");
    return file.contentType ? { data, name: file.name, contentType: file.contentType } : { data, name: file.name };
  });
}
function owned(grant: Grant, message: string): void {
  if (!grant.owned.has(message)) throw new RequestError("message is outside this grant");
}
function reply(status: number, value: unknown, maximum?: number): Response {
  const bytes = encoder.encode(JSON.stringify(value));
  if (maximum !== undefined && bytes.length > maximum) return new Response(null, { status: 502 });
  return new Response(bytes, { status, headers: { "content-type": "application/json" } });
}
