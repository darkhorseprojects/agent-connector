import { assertEquals } from "@std/assert";
import { stripBotMention } from "../src/discord.ts";

Deno.test("discord: strip bot mention correctly", () => {
  const botId = "123456789";

  assertEquals(stripBotMention("<@123456789> hello world", botId), " hello world");
  assertEquals(stripBotMention("<@!123456789> what is the time?", botId), " what is the time?");
  assertEquals(stripBotMention("Hey <@123456789>, help!", botId), "Hey , help!");
  assertEquals(stripBotMention("Message without mention", botId), null);
});
