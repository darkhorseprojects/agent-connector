import { assertEquals, assertThrows } from "@std/assert";
import { parseConfig } from "../src/config.ts";

const directory = Deno.build.os === "windows" ? "C:\\agents\\zinc" : "/opt/agents/zinc";

function source(extra = ""): string {
  return `
version: 1
discord:
  application: "123456789012345678"
  bot: "234567890123456789"
concurrency: 4
limits:
  pending_requests: 64
  pending_per_actor: 4
  frame_bytes: 8388608
  output_messages: 64
policies:
  zinc:
    entry: zinc.md
    mounts:
      host: host.md
      design: design.md
      discord: /opt/agent-connector/registrations/discord.md
    trusted_modules: [src.host, src.models, src.store, discord]
    directory: ${JSON.stringify(directory)}
    lua_memory: 96MiB
users:
  "345678901234567890": zinc
channels:
  "456789012345678901": zinc
guilds:
  "567890123456789012": zinc
${extra}`;
}

Deno.test("config parses exact explicit v1 data", () => {
  const config = parseConfig(source());
  assertEquals(config.concurrency, 4);
  assertEquals(config.limits, {
    pendingRequests: 64,
    pendingPerActor: 4,
    frameBytes: 8_388_608,
    outputMessages: 64,
  });
  assertEquals(config.policies.zinc.directory, directory);
  assertEquals(config.policies.zinc.luaMemory, "96MiB");
  assertEquals(config.policies.zinc.mounts[0].sourcePath, "host.md");
  assertEquals(config.policies.zinc.trustedModules, ["src.host", "src.models", "src.store", "discord"]);
});

Deno.test("config rejects unknown, implicit, and unsafe values", () => {
  assertThrows(() => parseConfig(source("unknown: true")), Error);
  assertThrows(
    () => parseConfig(source().replace("entry: zinc.md", "entry: ../zinc.md")),
    TypeError,
    "exact package path",
  );
  assertThrows(() => parseConfig(source().replace("concurrency: 4", "concurrency: 0")), Error);
  assertThrows(
    () => parseConfig(source().replace("  pending_requests: 64", "  pending_requests: 0")),
    Error,
  );
  assertThrows(
    () => parseConfig(source().replace("  pending_per_actor: 4", "  pending_per_actor: 65")),
    TypeError,
    "cannot exceed",
  );
  assertThrows(() => parseConfig(source().replace("345678901234567890", "short")), Error);
  assertThrows(() => parseConfig(source().replace("host: host.md", "bad-name!: host.md")), TypeError, "dotted Lua");
  assertThrows(
    () => parseConfig(source().replace(JSON.stringify(directory), JSON.stringify("relative"))),
    TypeError,
    "absolute",
  );
  assertThrows(() => parseConfig(source().replace("    lua_memory: 96MiB\n", "")), Error);
});
