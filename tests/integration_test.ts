import { assertEquals } from "@std/assert";
import { type Agent, run } from "@darkhorseprojects/portable-agents";
import { fromFileUrl, join } from "@std/path";
import { type DiscordRest, DiscordRpcServer } from "../src/discord/rpc.ts";
import { agentExecutable } from "../src/runtime/invoke.ts";

Deno.test("direct agent process receives the exact Discord value", async () => {
  const root = await Deno.makeTempDir({ prefix: "connector-integration-" });
  const rest = new Proxy({}, { get: () => () => Promise.resolve({}) }) as DiscordRest;
  const rpc = new DiscordRpcServer(rest, 8_388_608);
  try {
    await Deno.writeTextFile(
      join(root, "entry.lua"),
      "local discord=require('discord'); coroutine.yield(discord.context.actor)",
    );
    const capability = rpc.grant({
      actor: "actor-42",
      policy: "test",
      userId: "1",
      messageId: "2",
      channelId: "3",
    });
    const discord = fromFileUrl(new URL("../registrations/discord.md", import.meta.url));
    const agent: Agent = {
      target: { directory: root },
      entryPath: "entry.lua",
      mounts: [{ moduleName: "discord", sourcePath: discord }],
      trustedModules: ["discord"],
    };
    let output = "";
    const decoder = new TextDecoder();
    const home = Deno.env.get("HOME")!;
    const environment = {
      ...capability.environment,
      LUA_PATH_5_5: `${home}/.local/share/lua/5.5/?.lua;${home}/.local/share/lua/5.5/?/init.lua;;`,
      LUA_CPATH_5_5: `${home}/.local/lib/lua/5.5/?.so;;`,
    };
    for await (
      const chunk of run(agent, new Uint8Array(), {
        executable: agentExecutable(),
        environment,
        luaMemory: "96MiB",
      })
    ) {
      output += decoder.decode(chunk, { stream: true });
    }
    output += decoder.decode();
    assertEquals(output, "actor-42");
    capability.revoke();
  } finally {
    await rpc.close();
    await Deno.remove(root, { recursive: true });
  }
});
