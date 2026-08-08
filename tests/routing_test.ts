import { assertEquals } from "@std/assert";
import { stripBotMention } from "../src/discord.ts";
import { parseConfig } from "../src/config.ts";

Deno.test("discord: strip bot mention correctly", () => {
  const botId = "123456789";

  assertEquals(stripBotMention("<@123456789> hello world", botId), " hello world");
  assertEquals(stripBotMention("<@!123456789> what is the time?", botId), " what is the time?");
  assertEquals(stripBotMention("Hey <@123456789>, help!", botId), "Hey , help!");
  assertEquals(stripBotMention("Message without mention", botId), null);
});

Deno.test("discord: routing priority and guild fallback", () => {
  const yaml = `
version: 1
discord:
  application: "111"
  bot: "222"
policies:
  zinc:
    entry: zinc.md
    directory: /tmp
  analyst:
    entry: analyst.md
    directory: /tmp
users:
  "user1": zinc
channels:
  "chan_specific": analyst
guilds:
  "guild1": zinc
`;
  const config = parseConfig(yaml);

  // DM user mapping
  assertEquals(config.users["user1"], "zinc");

  // Specific channel takes precedence
  const resolvePolicy = (channelId: string, guildId?: string) =>
    config.channels[channelId] || (guildId ? config.guilds[guildId] : undefined);

  assertEquals(resolvePolicy("chan_specific", "guild1"), "analyst");

  // Other channel in guild falls back to guild policy
  assertEquals(resolvePolicy("chan_other", "guild1"), "zinc");

  // Unknown channel in unknown guild returns undefined
  assertEquals(resolvePolicy("chan_other", "guild_unknown"), undefined);
});
