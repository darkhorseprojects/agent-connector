import { assertEquals } from "@std/assert";
import { parseConfig, serializeConfig, type ConnectorConfig } from "../src/config.ts";

Deno.test("setup: serialize and parse roundtrip", () => {
  const original: ConnectorConfig = Object.freeze({
    version: 1,
    discord: Object.freeze({
      application: "123456789012345678",
      bot: "234567890123456789",
    }),
    policies: Object.freeze({
      zinc: {
        entry: "zinc.md",
        authority: Object.freeze(["src/store.lua", "src/memory.lua", "src/llamacpp.lua", "src/env.lua"]),
        directory: "/home/colin/dev/zinc",
        memoryBytes: 96 * 1024 * 1024,
        timeoutMs: 30_000,
      },
      analyst: {
        entry: "analyst.md",
        authority: Object.freeze(["src/store.lua"]),
        directory: "/home/colin/dev/zinc",
        memoryBytes: 128 * 1024 * 1024,
        timeoutMs: 60_000,
      },
    }),
    users: Object.freeze({
      "111": "zinc",
      "222": "analyst",
    }),
    channels: Object.freeze({
      "333": "zinc",
    }),
    guilds: Object.freeze({
      "444": "zinc",
    }),
  });

  const yamlStr = serializeConfig(original);
  const parsed = parseConfig(yamlStr);

  assertEquals(parsed.version, 1);
  assertEquals(parsed.discord.application, original.discord.application);
  assertEquals(parsed.discord.bot, original.discord.bot);
  assertEquals(parsed.policies.zinc.entry, "zinc.md");
  assertEquals(parsed.policies.zinc.memoryBytes, 96 * 1024 * 1024);
  assertEquals(parsed.policies.zinc.timeoutMs, 30_000);
  assertEquals(parsed.policies.analyst.entry, "analyst.md");
  assertEquals(parsed.policies.analyst.memoryBytes, 128 * 1024 * 1024);
  assertEquals(parsed.policies.analyst.timeoutMs, 60_000);
  assertEquals(parsed.users["111"], "zinc");
  assertEquals(parsed.users["222"], "analyst");
  assertEquals(parsed.channels["333"], "zinc");
  assertEquals(parsed.guilds["444"], "zinc");
});
