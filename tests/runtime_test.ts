import type { Message } from "discord.js";
import { parseConfig } from "../src/config.ts";
import { DiscordMessageStream } from "../src/discord/format.ts";
import { DiscordRenderer } from "../src/discord/renderer.ts";
import { type DiscordRest, DiscordRpcServer } from "../src/discord/rpc.ts";
import { route } from "../src/route.ts";

function expect(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("strict configuration feeds deterministic routing", () => {
  const config = parseConfig(JSON.stringify({
    version: 1,
    discord: { application: "123456789012345678", bot: "223456789012345678" },
    concurrency: 2,
    limits: { pendingRequests: 4, frameBytes: 4096, outputMessages: 8 },
    policies: { zinc: { directory: Deno.cwd(), entry: "zinc.md", mounts: {}, luaMemory: "16MiB" } },
    users: { "323456789012345678": "zinc" },
    channels: {},
    guilds: {},
  }));
  const request = route(config, {
    author: { id: "323456789012345678", bot: false },
    webhookId: null,
    channel: { isThread: () => false },
    guildId: null,
    channelId: "423456789012345678",
    content: " hello ",
    mentions: { users: { has: () => false } },
  } as unknown as Message);
  expect(request?.policy === "zinc" && request.input === "hello" && !request.createThread, "route was incorrect");
});

Deno.test("message formatting and rendering preserve bounded fence state", async () => {
  const stream = new DiscordMessageStream(32);
  stream.append("```lua\n" + "x".repeat(60) + "\n```");
  const chunks = stream.snapshot();
  expect(chunks.length > 1 && chunks.every((chunk) => chunk.length <= 32), "split was not bounded");
  const sent: Array<{ content: string }> = [];
  const renderer = new DiscordRenderer({
    send(options) {
      const value = { content: options.content };
      sent.push(value);
      return Promise.resolve({
        edit(next) {
          value.content = next.content;
          return Promise.resolve();
        },
      });
    },
  }, { outputMessages: 4 });
  await renderer.push({ type: "response", text: "answer" });
  await renderer.push({ type: "response_complete" });
  await renderer.push({ type: "done", durable: false });
  await renderer.finish();
  expect(sent.length === 1 && sent[0].content === "answer", "rendered output was incorrect");
});

Deno.test("Discord RPC confines mutation to a live grant", async () => {
  const calls: string[] = [];
  const rest = Object.fromEntries(["get", "post", "put", "patch", "delete"].map((method) => [
    method,
    (path: string) => {
      calls.push(`${method}:${path}`);
      return Promise.resolve(method === "post" ? { id: "523456789012345678" } : {});
    },
  ])) as DiscordRest;
  const rpc = new DiscordRpcServer(rest, 4096);
  const grant = rpc.grant({
    actor: "actor",
    policy: "zinc",
    userId: "123456789012345678",
    messageId: "223456789012345678",
    messageChannelId: "323456789012345678",
    channelId: "323456789012345678",
  });
  const request = (value: unknown) => {
    const body = JSON.stringify(value);
    return fetch(`${grant.environment.AGENT_CONNECTOR_DISCORD_URL}/v1/request`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.environment.AGENT_CONNECTOR_DISCORD_TOKEN}`,
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).length),
      },
      body,
    });
  };
  try {
    expect((await request({ type: "createMessage", content: "hello" })).status === 200, "create failed");
    expect(
      (await request({ type: "editMessage", message: "523456789012345678", content: "updated" })).status === 200,
      "owned edit failed",
    );
    expect(
      (await request({ type: "deleteMessage", message: "623456789012345678" })).status === 400,
      "foreign delete was allowed",
    );
    grant.revoke();
    expect((await request({ type: "getMessage", message: "223456789012345678" })).status === 401, "revocation failed");
    expect(calls.length === 2, "unexpected Discord mutations");
  } finally {
    await rpc.close();
  }
});
