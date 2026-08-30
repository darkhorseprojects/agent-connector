import { assertEquals, assertThrows } from "@std/assert";
import { parseConfig } from "../src/config.ts";

const application = "0".repeat(17);
const bot = "1".repeat(17);
const user = "2".repeat(17);
const directory = Deno.build.os === "windows" ? "C:\\zinc" : "/zinc";
const source = () => `
version: 1
discord:
  application: "${application}"
  bot: "${bot}"
concurrency: 4
limits:
  pending_requests: 64
  frame_bytes: 1048576
  output_messages: 32
policies:
  zinc:
    directory: "${directory.replaceAll("\\", "\\\\")}"
    entry: zinc.md
    mounts:
      design: design.md
    lua_memory: 96MiB
    process_memory: 512MiB
    wall_time: 2m
users:
  "${user}": zinc
channels: {}
guilds: {}
`;

Deno.test("configuration decodes directly to policies", () => {
  const config = parseConfig(source());
  assertEquals(config.discord, { application, bot });
  assertEquals(config.limits.pendingRequests, 64);
  assertEquals(config.policies.zinc.mounts, { design: "design.md" });
  assertEquals(config.users[user], "zinc");
});

Deno.test("configuration rejects Connector-owned discord mount", () => {
  assertThrows(() => parseConfig(source().replace("design: design.md", "discord: discord.md")));
});
