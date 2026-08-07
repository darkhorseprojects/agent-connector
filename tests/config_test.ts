import { assertEquals, assertThrows } from "@std/assert";
import { parseConfig, parseMemory, parseTimeout } from "../src/config.ts";

Deno.test("config: parse valid memory and timeout", () => {
  assertEquals(parseMemory("96MiB"), 96 * 1024 * 1024);
  assertEquals(parseMemory("1GiB"), 1024 * 1024 * 1024);
  assertEquals(parseMemory("500KB"), 500 * 1000);
  assertEquals(parseTimeout("30s"), 30_000);
  assertEquals(parseTimeout("2m"), 120_000);
  assertEquals(parseTimeout("500ms"), 500);
});

Deno.test("config: parse strict agent-connector.yaml", () => {
  const yaml = `
version: 1
discord:
  application: "123456789"
  bot: "987654321"
policies:
  zinc:
    entry: zinc.md
    authority:
      - src/store.lua
      - src/llamacpp.lua
    directory: /home/colin/dev/zinc
    memory: 96MiB
    timeout: 30s
users:
  "111": zinc
channels:
  "222": zinc
guilds:
  "333": zinc
`;

  const config = parseConfig(yaml, "/home/colin/dev/zinc");
  assertEquals(config.version, 1);
  assertEquals(config.discord.application, "123456789");
  assertEquals(config.discord.bot, "987654321");
  assertEquals(config.policies.zinc.entry, "zinc.md");
  assertEquals(config.policies.zinc.directory, "/home/colin/dev/zinc");
  assertEquals(config.policies.zinc.memoryBytes, 96 * 1024 * 1024);
  assertEquals(config.policies.zinc.timeoutMs, 30_000);
  assertEquals(config.users["111"], "zinc");
  assertEquals(config.channels["222"], "zinc");
  assertEquals(config.guilds["333"], "zinc");
});

Deno.test("config: reject relative policy directory", () => {
  const yaml = `
version: 1
discord:
  application: "1"
  bot: "2"
policies:
  test:
    entry: test.md
    directory: ./relative/path
`;
  assertThrows(() => parseConfig(yaml, "/pkg"), TypeError, "directory must be an absolute path");
});
