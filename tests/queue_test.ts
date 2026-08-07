import { assertEquals, assertRejects } from "@std/assert";
import { RequestQueue } from "../src/queue.ts";

Deno.test("queue: concurrent execution and limits", async () => {
  const queue = new RequestQueue(2, 2);

  let active = 0;
  let maxActive = 0;

  const runTask = async (delayMs: number) => {
    return await queue.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delayMs));
      active--;
      return "done";
    });
  };

  const p1 = runTask(50);
  const p2 = runTask(50);
  const p3 = runTask(50);
  const p4 = runTask(50);

  // 5th task exceeds queue limit (2 active + 2 queued = 4 total capacity)
  await assertRejects(
    async () => await runTask(50),
    Error,
    "Agent Connector is busy.",
  );

  const results = await Promise.all([p1, p2, p3, p4]);
  assertEquals(results, ["done", "done", "done", "done"]);
  assertEquals(maxActive, 2);
});
