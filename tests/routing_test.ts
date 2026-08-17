import { assertEquals } from "@std/assert";
import { parseConfig } from "../src/config.ts";
import { type IncomingMessage, route, stripBotMention } from "../src/route.ts";

const config = parseConfig(`
version: 1
discord:
  application: "123456789012345678"
  bot: "234567890123456789"
concurrency: 2
limits:
  pending_requests: 64
  pending_per_actor: 4
  event_bytes: 1048576
  output_bytes: 8388608
  output_messages: 64
  rpc_bytes: 8388608
policies:
  zinc:
    entry: zinc.md
    register: {}
    authorize: []
    directory: /tmp
    memory: 96MiB
    timeout: 30s
  analyst:
    entry: analyst.md
    register: {}
    authorize: []
    directory: /tmp
    memory: 96MiB
    timeout: 30s
users:
  "345678901234567890": zinc
channels:
  "456789012345678901": analyst
guilds:
  "567890123456789012": zinc
`);

const base: IncomingMessage = {
  authorId: "345678901234567890",
  authorIsBot: false,
  webhook: false,
  channelId: "456789012345678901",
  content: "inspect",
  mentionedBot: false,
};

Deno.test("route handles DMs through production logic", () => {
  const result = route(config, base);
  assertEquals(result?.policy, "zinc");
  assertEquals(result?.actor, "discord:123456789012345678:zinc:user:345678901234567890");
});

Deno.test("exact channel and thread parent precede guild fallback", () => {
  const channel = route(config, { ...base, guildId: "567890123456789012" });
  assertEquals(channel?.policy, "analyst");
  assertEquals(channel?.createThread, true);

  const thread = route(config, {
    ...base,
    channelId: "789012345678901234",
    parentChannelId: "456789012345678901",
    guildId: "567890123456789012",
  });
  assertEquals(thread?.policy, "analyst");
  assertEquals(thread?.createThread, false);
});

Deno.test("guild fallback requires and strips a mention", () => {
  const channelId = "789012345678901234";
  assertEquals(route(config, { ...base, channelId, guildId: "567890123456789012" }), null);
  const result = route(config, {
    ...base,
    channelId,
    guildId: "567890123456789012",
    mentionedBot: true,
    content: "<@234567890123456789> inspect",
  });
  assertEquals(result?.policy, "zinc");
  assertEquals(result?.input, "inspect");
});

Deno.test("route ignores bots, webhooks, and empty messages", () => {
  assertEquals(route(config, { ...base, authorIsBot: true }), null);
  assertEquals(route(config, { ...base, webhook: true }), null);
  assertEquals(route(config, { ...base, content: "  " }), null);
  assertEquals(stripBotMention("hello", config.discord.bot), null);
});
