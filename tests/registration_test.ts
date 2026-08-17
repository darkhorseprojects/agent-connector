import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { parseConfig } from "../src/config.ts";

Deno.test("Discord is one explicit registered and authorized Markdown source", async () => {
  const discord = fromFileUrl(new URL("../registrations/discord.md", import.meta.url));
  const config = parseConfig(`
version: 1
discord: { application: "123456789012345678", bot: "234567890123456789" }
concurrency: 1
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
    register: { discord: ${JSON.stringify(discord)} }
    authorize: [discord]
    directory: /agents/zinc
    memory: 96MiB
    timeout: 30s
users: {}
channels: {}
guilds: {}
`);
  assertEquals(config.policies.zinc.register, { discord });
  assertEquals(config.policies.zinc.authorize, ["discord"]);
  const source = await Deno.readTextFile(discord);
  assertStringIncludes(source, "## Guide");
  assertStringIncludes(source, "## Program");
  assertStringIncludes(source, "guide = document.Discord.Guide");
});
