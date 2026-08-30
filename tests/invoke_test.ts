import { Chunk, Effect, Stream } from "effect";
import type { Policy } from "../src/config.ts";
import { runAgent } from "../src/runtime/invoke.ts";
import { assertEquals, assertRejects } from "@std/assert";

async function fixture(events: string): Promise<{ policy: Policy; cleanup(): Promise<void> }> {
  const directory = await Deno.makeTempDir({ prefix: "agc-invoke-" });
  await Deno.writeTextFile(
    `${directory}/entry.lua`,
    `
return function()
  local events = ${events}
  local index = 0
  return function()
    index = index + 1
    return events[index]
  end
end
`,
  );
  return {
    policy: {
      entry: "entry.lua",
      mounts: {},
      directory,
      luaMemory: "8MiB",
      processMemory: "64MiB",
      wallTime: "10s",
    },
    cleanup: () => Deno.remove(directory, { recursive: true }),
  };
}

async function collect(policy: Policy) {
  const environment = {
    AGENT_CONNECTOR_DISCORD_URL: "http://127.0.0.1:9",
    AGENT_CONNECTOR_DISCORD_TOKEN: "test",
    AGENT_CONNECTOR_DISCORD_CONTEXT: "{}",
    AGENT_CONNECTOR_FRAME_BYTES: "4096",
  };
  return Chunk.toReadonlyArray(
    await Effect.runPromise(Stream.runCollect(runAgent(policy, "actor", "request", 4096, environment))),
  );
}

Deno.test("invoke accepts durable Store and temporary Done", async () => {
  const durable = await fixture(`{
    { type = "reasoning", text = "think" },
    { type = "reasoning_complete", result = 2 },
    { type = "response", text = "answer" },
    { type = "response_complete", result = 3 },
    { type = "store", result = 3, start = 1 },
  }`);
  const temporary = await fixture(`{
    { type = "response", text = "answer" },
    { type = "response_complete" },
    { type = "done", durable = false },
  }`);
  try {
    assertEquals((await collect(durable.policy)).at(-1)?.type, "store");
    assertEquals((await collect(temporary.policy)).at(-1)?.type, "done");
  } finally {
    await durable.cleanup();
    await temporary.cleanup();
  }
});

Deno.test("invoke accepts parallel call/result ordering", async () => {
  const value = await fixture(`{
    { type = "tool_call", call = "a", code = "return 1", result = 2 },
    { type = "tool_call", call = "b", code = "return 2", result = 3 },
    { type = "tool_result", call = "b", text = "2", ok = true, result = 4 },
    { type = "tool_result", call = "a", text = "1", ok = true, result = 5 },
    { type = "response", text = "done" },
    { type = "response_complete", result = 6 },
    { type = "store", result = 6, start = 1 },
  }`);
  try {
    assertEquals((await collect(value.policy)).map((event) => event.type), [
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "response",
      "response_complete",
      "store",
    ]);
  } finally {
    await value.cleanup();
  }
});

Deno.test("invoke requires one final terminal event", async () => {
  const missing = await fixture(`{{ type = "response", text = "x" }}`);
  const following = await fixture(`{
    { type = "done", durable = false },
    { type = "response", text = "x" },
  }`);
  try {
    await assertRejects(() => collect(missing.policy));
    await assertRejects(() => collect(following.policy));
  } finally {
    await missing.cleanup();
    await following.cleanup();
  }
});
