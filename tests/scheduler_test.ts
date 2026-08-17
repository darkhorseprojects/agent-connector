import { assertEquals, assertRejects } from "@std/assert";
import { Scheduler, SchedulerCapacityError } from "../src/runtime/scheduler.ts";

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

Deno.test("scheduler preserves actor FIFO and runs different actors concurrently", async () => {
  const scheduler = new Scheduler(2, 8, 4);
  const signal = new AbortController().signal;
  const order: string[] = [];
  let active = 0;
  let maximum = 0;
  const task = (name: string, delay: number) => async () => {
    active++;
    maximum = Math.max(maximum, active);
    order.push(`${name}:start`);
    await wait(delay);
    order.push(`${name}:end`);
    active--;
    return name;
  };

  const results = await Promise.all([
    scheduler.run("a", signal, task("a1", 20)),
    scheduler.run("a", signal, task("a2", 1)),
    scheduler.run("b", signal, task("b1", 10)),
  ]);
  assertEquals(results, ["a1", "a2", "b1"]);
  assertEquals(maximum, 2);
  assertEquals(order.indexOf("a2:start") > order.indexOf("a1:end"), true);
});

Deno.test("scheduler aborts waiting and active work", async () => {
  const scheduler = new Scheduler(1, 8, 4);
  const active = new AbortController();
  const waiting = new AbortController();
  const first = scheduler.run(
    "a",
    active.signal,
    (signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  );
  const second = scheduler.run("a", waiting.signal, () => Promise.resolve("unexpected"));
  waiting.abort(new Error("waiting cancelled"));
  await assertRejects(() => second, Error, "waiting cancelled");
  active.abort(new Error("active cancelled"));
  await assertRejects(() => first, Error, "active cancelled");
});

Deno.test("scheduler rejects global and per-actor queue overflow", async () => {
  const signal = new AbortController().signal;
  const blocked = (taskSignal: AbortSignal) =>
    new Promise<never>((_resolve, reject) =>
      taskSignal.addEventListener("abort", () => reject(taskSignal.reason), { once: true })
    );

  const global = new Scheduler(1, 2, 2);
  const active = global.run("a", signal, blocked);
  const first = global.run("b", signal, () => Promise.resolve());
  const second = global.run("c", signal, () => Promise.resolve());
  await assertRejects(
    () => global.run("d", signal, () => Promise.resolve()),
    SchedulerCapacityError,
    "request queue is full",
  );
  await global.close(new Error("closed"));
  await Promise.allSettled([active, first, second]);

  const actor = new Scheduler(1, 3, 1);
  const actorActive = actor.run("a", signal, blocked);
  const actorWaiting = actor.run("a", signal, () => Promise.resolve());
  await assertRejects(
    () => actor.run("a", signal, () => Promise.resolve()),
    SchedulerCapacityError,
    "actor request queue is full",
  );
  const other = actor.run("b", signal, () => Promise.resolve());
  await actor.close(new Error("closed"));
  await Promise.allSettled([actorActive, actorWaiting, other]);
});

Deno.test("waiting cancellation releases per-actor capacity", async () => {
  const scheduler = new Scheduler(1, 2, 1);
  const activeController = new AbortController();
  const waitingController = new AbortController();
  const active = scheduler.run(
    "a",
    activeController.signal,
    (signal) =>
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      ),
  );
  const waiting = scheduler.run("a", waitingController.signal, () => Promise.resolve());
  waitingController.abort(new Error("cancelled"));
  await assertRejects(() => waiting, Error, "cancelled");
  assertEquals(scheduler.waitingCount, 0);
  const replacement = scheduler.run("a", new AbortController().signal, () => Promise.resolve());
  activeController.abort(new Error("done"));
  await assertRejects(() => active, Error, "done");
  await replacement;
  await scheduler.close();
});

Deno.test("scheduler close rejects waiting and active work", async () => {
  const scheduler = new Scheduler(1, 8, 4);
  const signal = new AbortController().signal;
  const first = scheduler.run(
    "a",
    signal,
    (taskSignal) =>
      new Promise((_resolve, reject) =>
        taskSignal.addEventListener("abort", () => reject(taskSignal.reason), { once: true })
      ),
  );
  const second = scheduler.run("a", signal, () => Promise.resolve("unexpected"));
  await scheduler.close(new Error("closed"));
  await assertRejects(() => first, Error, "closed");
  await assertRejects(() => second, Error, "closed");
});
