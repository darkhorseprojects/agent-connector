import { assertEquals } from "@std/assert";
import { type ConnectorConfig, parseConfig, serializeConfig } from "../src/config.ts";

Deno.test("configuration serialization preserves explicit policy", () => {
  const directory = Deno.build.os === "windows" ? "C:\\agents\\zinc" : "/opt/agents/zinc";
  const original: ConnectorConfig = Object.freeze({
    version: 1,
    discord: Object.freeze({ application: "123456789012345678", bot: "234567890123456789" }),
    concurrency: 4,
    limits: Object.freeze({
      pendingRequests: 64,
      pendingPerActor: 4,
      frameBytes: 8_388_608,
      outputMessages: 64,
    }),
    policies: Object.freeze({
      zinc: Object.freeze({
        entry: "zinc.md",
        mounts: Object.freeze([
          Object.freeze({ moduleName: "host", sourcePath: "host.md" }),
          Object.freeze({ moduleName: "design", sourcePath: "design.md" }),
          Object.freeze({ moduleName: "discord", sourcePath: "/opt/connector/registrations/discord.md" }),
        ]),
        trustedModules: Object.freeze(["src.host", "src.models", "src.store", "discord"]),
        directory,
        luaMemory: "96MiB",
      }),
    }),
    users: Object.freeze({ "345678901234567890": "zinc" }),
    channels: Object.freeze({ "456789012345678901": "zinc" }),
    guilds: Object.freeze({ "567890123456789012": "zinc" }),
  });
  assertEquals(parseConfig(serializeConfig(original)), original);
});
