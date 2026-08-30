import { assertEquals } from "@std/assert";
import { parseConfig } from "../src/config.ts";
import { route } from "../src/route.ts";

const application = "0".repeat(17);
const bot = "1".repeat(17);
const user = "2".repeat(17);
const channel = "3".repeat(17);
const guild = "4".repeat(17);
const other = "5".repeat(17);
const directory = Deno.build.os === "windows" ? "C:\\zinc" : "/zinc";
const config = parseConfig(`
version: 1
discord: { application: "${application}", bot: "${bot}" }
concurrency: 2
limits: { pending_requests: 4, frame_bytes: 4096, output_messages: 8 }
policies:
  zinc:
    directory: "${directory.replaceAll("\\", "\\\\")}"
    entry: zinc.md
    mounts: {}
    lua_memory: 64MiB
users: { "${user}": zinc }
channels: { "${channel}": zinc }
guilds: { "${guild}": zinc }
`);
const base = {
  authorId: user,
  authorIsBot: false,
  webhook: false,
  channelId: other,
  content: "inspect",
  mentionedBot: false,
};

Deno.test("direct messages route by user", () => {
  const result = route(config, base);
  assertEquals(result?.actor, `discord:${application}:zinc:user:${user}`);
  assertEquals(result?.createThread, false);
});
Deno.test("configured channels start threads and existing threads reuse policy", () => {
  assertEquals(route(config, { ...base, channelId: channel, guildId: guild })?.createThread, true);
  assertEquals(
    route(config, { ...base, channelId: other, parentChannelId: channel, guildId: guild })?.createThread,
    false,
  );
});
Deno.test("guild route requires and strips the bot mention", () => {
  assertEquals(route(config, { ...base, guildId: guild }), null);
  const result = route(config, { ...base, guildId: guild, mentionedBot: true, content: `<@${bot}> inspect` });
  assertEquals(result?.input, "inspect");
});
Deno.test("bots and webhooks do not route", () => {
  assertEquals(route(config, { ...base, authorIsBot: true }), null);
  assertEquals(route(config, { ...base, webhook: true }), null);
});
