import { assertEquals } from "@std/assert";
import { type Agent, run } from "@darkhorseprojects/portable-agents";
import { fromFileUrl, join } from "@std/path";
import { Effect, Stream } from "effect";
import { type DiscordRest, DiscordRpcServer } from "../src/discord/rpc.ts";
import { agentExecutable } from "../src/runtime/invoke.ts";

Deno.test("direct agent process receives the invocation Discord value", async () => {
  const root = await Deno.makeTempDir({ prefix: "connector-integration-" });
  const rest = new Proxy({}, { get: () => () => Promise.resolve({}) }) as DiscordRest;
  const rpc = new DiscordRpcServer(rest, 8_388_608);
  try {
    await Deno.writeTextFile(
      join(root, "entry.lua"),
      `
return function()
  return require("discord").context.actor
end
`,
    );
    const capability = rpc.grant({
      actor: "actor-42",
      policy: "test",
      userId: "1",
      messageId: "2",
      channelId: "3",
    });
    const discord = fromFileUrl(new URL("../discord.md", import.meta.url));
    const agent: Agent = {
      directory: root,
      entry: "entry.lua",
      mounts: { discord },
    };
    const values = await Effect.runPromise(Stream.runCollect(run(agent, "", {
      executable: agentExecutable(),
      environment: capability.environment,
      luaMemory: "16MiB",
    })));
    assertEquals(values, ["actor-42"]);
    capability.revoke();
  } finally {
    await rpc.close();
    await Deno.remove(root, { recursive: true });
  }
});
