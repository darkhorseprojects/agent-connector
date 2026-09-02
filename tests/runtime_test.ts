import { assertEquals, assertRejects } from "@std/assert";
import type { Message } from "discord.js";
import { configureIdentity, parseBootstrapConfig, parseConfig } from "../src/config.ts";
import { writeAtomic } from "../src/discord/credentials.ts";
import { DiscordMessageStream } from "../src/discord/format.ts";
import { DiscordRenderer } from "../src/discord/renderer.ts";
import { type DiscordRest, DiscordRpcServer } from "../src/discord/rpc.ts";
import { route } from "../src/route.ts";

const APP = "123456789012345678";
const BOT = "223456789012345678";
const USER = "323456789012345678";
const CHANNEL = "423456789012345678";
const MESSAGE = "523456789012345678";
const yaml = `version: 1
discord:
  application: "${APP}"
  bot: "${BOT}"
concurrency: 2
limits:
  frame_bytes: 4096
  output_messages: 8
policies:
  zinc:
    directory: "."
    entry: zinc.md
    mounts: {}
    lua_memory: 16MiB
    environment:
      PATH: PATH
    runtime:
      maximum_model_calls: 4
users:
  "${USER}": zinc
channels: {}
guilds: {}
`;

Deno.test("strict YAML feeds relative policies, runtime, and deterministic routing", () => {
  const config = parseConfig(yaml, Deno.cwd());
  assertEquals(config.policies.zinc.directory, Deno.cwd());
  assertEquals(config.policies.zinc.environment, { PATH: "PATH" });
  assertEquals(JSON.parse(config.policies.zinc.runtime!), { maximum_model_calls: 4 });
  const request = route(config, {
    author: { id: USER, bot: false },
    webhookId: null,
    channel: { isThread: () => false },
    guildId: null,
    channelId: CHANNEL,
    content: " hello ",
    mentions: { users: { has: () => false } },
  } as unknown as Message);
  assertEquals(request, {
    policy: "zinc",
    actor: `discord:${APP}:zinc:user:${USER}`,
    input: "hello",
    createThread: false,
  });
  assertRejects(() =>
    Promise.resolve().then(() => parseConfig(yaml.replace("version: 1", "version: 1\nunknown: true"), Deno.cwd()))
  );
  const bootstrap = configureIdentity(
    "version: 1\ndiscord: {}\npolicies: {}\nusers: {}\nchannels: {}\nguilds: {}\n",
    APP,
    BOT,
  );
  assertEquals(parseBootstrapConfig(bootstrap, Deno.cwd()).discord, { application: APP, bot: BOT });
});

Deno.test("atomic create never replaces an existing configuration", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/agent-connector.yaml`;
  try {
    await writeAtomic(path, "first", true, 0o644);
    await assertRejects(() => writeAtomic(path, "second", true, 0o644), Deno.errors.AlreadyExists);
    assertEquals(await Deno.readTextFile(path), "first");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("formatting discards whitespace and preserves bounded fences and Unicode", async () => {
  const stream = new DiscordMessageStream(32);
  stream.append("   \n\t");
  assertEquals(stream.snapshot(), []);
  stream.append("```lua\n" + "😀".repeat(30) + "\n```");
  const chunks = stream.snapshot();
  if (chunks.length < 2 || chunks.some((chunk) => chunk.length > 32 || /[\uD800-\uDBFF]$/.test(chunk))) {
    throw new Error("split was not bounded or Unicode-safe");
  }
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
  });
  await renderer.push({ type: "reasoning", text: "because\n" });
  await renderer.push({ type: "reasoning_complete" });
  await renderer.push({ type: "response", text: "   " });
  await renderer.push({ type: "response", text: "answer" });
  await renderer.push({ type: "response_complete" });
  await renderer.push({ type: "done", durable: false });
  await renderer.finish();
  assertEquals(sent.map((value) => value.content), ["> because", "answer"]);
});

Deno.test("Discord RPC linearizes revocation and retains failed-delete ownership", async () => {
  const calls: string[] = [];
  let failDelete = true;
  let releaseGet!: () => void;
  const startedGet = Promise.withResolvers<void>();
  const pendingGet = new Promise<void>((resolve) => releaseGet = resolve);
  const rest = Object.fromEntries(["get", "post", "put", "patch", "delete"].map((method) => [
    method,
    async (path: string) => {
      calls.push(`${method}:${path}`);
      if (method === "get") {
        startedGet.resolve();
        await pendingGet;
      }
      if (method === "delete" && failDelete) {
        failDelete = false;
        throw new Error("delete failed");
      }
      return method === "post" ? { id: MESSAGE } : {};
    },
  ])) as DiscordRest;
  const rpc = new DiscordRpcServer(rest, 4096, 30000);
  const grant = rpc.grant({
    actor: "actor",
    policy: "zinc",
    userId: USER,
    messageId: BOT,
    messageChannelId: CHANNEL,
    channelId: CHANNEL,
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
    const create = await request({ type: "createMessage", content: "hello" });
    assertEquals(await create.json(), { id: MESSAGE });
    assertEquals((await request({ type: "deleteMessage", message: MESSAGE })).status, 502);
    assertEquals((await request({ type: "deleteMessage", message: MESSAGE })).status, 200);
    const pending = request({ type: "getMessage", message: BOT });
    await startedGet.promise;
    grant.revoke();
    releaseGet();
    assertEquals((await pending).status, 200);
    assertEquals((await request({ type: "getMessage", message: BOT })).status, 401);
    assertEquals(calls.filter((call) => call.startsWith("delete:")).length, 2);
  } finally {
    releaseGet?.();
    await rpc.close();
  }
});
