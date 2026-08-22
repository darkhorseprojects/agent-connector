import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { parseConfig } from "../src/config.ts";

Deno.test("Discord is one explicit mounted and trusted Markdown source", async () => {
  const discord = fromFileUrl(new URL("../registrations/discord.md", import.meta.url));
  const config = parseConfig(`
version: 1
discord: { application: "123456789012345678", bot: "234567890123456789" }
concurrency: 1
limits:
  pending_requests: 64
  pending_per_actor: 4
  frame_bytes: 8388608
  output_messages: 64
policies:
  zinc:
    entry: zinc.md
    mounts: { discord: ${JSON.stringify(discord)} }
    trusted_modules: [discord]
    directory: /agents/zinc
    lua_memory: 96MiB
    timeout: 30s
users: {}
channels: {}
guilds: {}
`);
  assertEquals(config.policies.zinc.mounts, [{ moduleName: "discord", sourcePath: discord }]);
  assertEquals(config.policies.zinc.trustedModules, ["discord"]);
  const source = await Deno.readTextFile(discord);
  assertStringIncludes(source, "## Guide");
  assertStringIncludes(source, "## Program");
  assertStringIncludes(source, "guide = document.Discord.Guide");
});
