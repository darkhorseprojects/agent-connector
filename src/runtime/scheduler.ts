export class SchedulerCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerCapacityError";
  }
}

type Waiting = {
  actor: string;
  signal: AbortSignal;
  task: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  abort: () => void;
};

export class Scheduler {
  readonly #maximumActive: number;
  readonly #maximumWaiting: number;
  readonly #maximumWaitingPerActor: number;
  readonly #waiting: Waiting[] = [];
  readonly #waitingByActor = new Map<string, number>();
  readonly #actors = new Set<string>();
  readonly #controllers = new Set<AbortController>();
  readonly #activeTasks = new Set<Promise<void>>();
  #active = 0;
  #closed: unknown;

  constructor(maximumActive: number, maximumWaiting: number, maximumWaitingPerActor: number) {
    for (
      const [name, value] of [
        ["maximumActive", maximumActive],
        ["maximumWaiting", maximumWaiting],
        ["maximumWaitingPerActor", maximumWaitingPerActor],
      ] as const
    ) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
    }
    if (maximumWaitingPerActor > maximumWaiting) {
      throw new RangeError("maximumWaitingPerActor cannot exceed maximumWaiting");
    }
    this.#maximumActive = maximumActive;
    this.#maximumWaiting = maximumWaiting;
    this.#maximumWaitingPerActor = maximumWaitingPerActor;
  }

  get activeCount(): number {
    return this.#active;
  }

  get waitingCount(): number {
    return this.#waiting.length;
  }

  run<T>(
    actor: string,
    signal: AbortSignal,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    const canStart = this.#active < this.#maximumActive && !this.#actors.has(actor);
    if (!canStart && this.#waiting.length >= this.#maximumWaiting) {
      return Promise.reject(new SchedulerCapacityError("request queue is full"));
    }
    const actorWaiting = this.#waitingByActor.get(actor) ?? 0;
    if (!canStart && actorWaiting >= this.#maximumWaitingPerActor) {
      return Promise.reject(new SchedulerCapacityError("actor request queue is full"));
    }
    return new Promise<T>((resolve, reject) => {
      const waiting: Waiting = {
        actor,
        signal,
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
        abort: () => {
          const index = this.#waiting.indexOf(waiting);
          if (index >= 0) {
            this.#waiting.splice(index, 1);
            this.#removeWaitingCount(actor);
            reject(signal.reason);
          }
        },
      };
      signal.addEventListener("abort", waiting.abort, { once: true });
      this.#waiting.push(waiting);
      this.#waitingByActor.set(actor, actorWaiting + 1);
      this.#pump();
    });
  }

  async close(reason: unknown = new Error("Agent Connector stopped.")): Promise<void> {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    for (const waiting of this.#waiting.splice(0)) {
      waiting.signal.removeEventListener("abort", waiting.abort);
      this.#removeWaitingCount(waiting.actor);
      waiting.reject(reason);
    }
    for (const controller of this.#controllers) controller.abort(reason);
    await Promise.allSettled([...this.#activeTasks]);
  }

  #pump(): void {
    while (this.#active < this.#maximumActive) {
      const index = this.#waiting.findIndex((waiting) => !this.#actors.has(waiting.actor));
      if (index < 0) return;
      const [waiting] = this.#waiting.splice(index, 1);
      this.#removeWaitingCount(waiting.actor);
      waiting.signal.removeEventListener("abort", waiting.abort);
      if (waiting.signal.aborted) {
        waiting.reject(waiting.signal.reason);
        continue;
      }

      this.#active++;
      this.#actors.add(waiting.actor);
      const controller = new AbortController();
      this.#controllers.add(controller);
      const abort = () => controller.abort(waiting.signal.reason);
      waiting.signal.addEventListener("abort", abort, { once: true });

      const running = this.#execute(waiting, controller, abort);
      this.#activeTasks.add(running);
      running.finally(() => this.#activeTasks.delete(running));
    }
  }

  #removeWaitingCount(actor: string): void {
    const count = this.#waitingByActor.get(actor);
    if (count === undefined) throw new Error("scheduler waiting count is inconsistent");
    if (count === 1) this.#waitingByActor.delete(actor);
    else this.#waitingByActor.set(actor, count - 1);
  }

  async #execute(waiting: Waiting, controller: AbortController, abort: () => void): Promise<void> {
    try {
      waiting.resolve(await waiting.task(controller.signal));
    } catch (error) {
      waiting.reject(error);
    } finally {
      waiting.signal.removeEventListener("abort", abort);
      this.#controllers.delete(controller);
      this.#actors.delete(waiting.actor);
      this.#active--;
      this.#pump();
    }
  }
}
