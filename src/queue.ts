export class RequestQueue {
  readonly #maxConcurrent: number;
  readonly #maxQueueSize: number;
  #active = 0;
  readonly #queue: Array<() => Promise<void>> = [];

  constructor(maxConcurrent = 4, maxQueueSize = 32) {
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueueSize = maxQueueSize;
  }

  get activeCount(): number {
    return this.#active;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#maxConcurrent && this.#queue.length >= this.#maxQueueSize) {
      throw new Error("Agent Connector is busy.");
    }

    if (this.#active < this.#maxConcurrent) {
      return await this.#execute(task);
    }

    return await new Promise<T>((resolve, reject) => {
      this.#queue.push(async () => {
        try {
          const result = await this.#execute(task);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async #execute<T>(task: () => Promise<T>): Promise<T> {
    this.#active++;
    try {
      return await task();
    } finally {
      this.#active--;
      const next = this.#queue.shift();
      if (next) {
        next();
      }
    }
  }
}
