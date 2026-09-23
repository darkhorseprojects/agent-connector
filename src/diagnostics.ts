import { dirname, isAbsolute, join } from "@std/path";

export class OperatorLog {
  readonly #path: string;
  #pending: Promise<void> = Promise.resolve();

  constructor() {
    const home = Deno.env.get(Deno.build.os === "windows" ? "USERPROFILE" : "HOME");
    const configured = Deno.env.get(Deno.build.os === "windows" ? "LOCALAPPDATA" : "XDG_STATE_HOME");
    if (!home || !isAbsolute(home)) throw new Error("home directory is unavailable");
    const state = configured && isAbsolute(configured)
      ? configured
      : Deno.build.os === "windows"
      ? join(home, "AppData", "Local")
      : Deno.build.os === "darwin"
      ? join(home, "Library", "Logs")
      : join(home, ".local", "state");
    this.#path = join(state, "agent-connector", "requests.jsonl");
  }

  record(id: string, stage: string, elapsedMs?: number, code?: string): Promise<void> {
    const line = JSON.stringify({ time: new Date().toISOString(), id, stage, elapsedMs, code }) + "\n";
    const write = this.#pending.then(async () => {
      await Deno.mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const size = await Deno.stat(this.#path).then((file) => file.size, (error) => {
        if (error instanceof Deno.errors.NotFound) return 0;
        throw error;
      });
      if (size + line.length > 8 * 1024 * 1024) {
        await Deno.remove(this.#path + ".1").catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
        await Deno.rename(this.#path, this.#path + ".1");
      }
      await Deno.writeTextFile(this.#path, line, { append: true, create: true, mode: 0o600 });
    });
    this.#pending = write.catch(() => {});
    return write;
  }
}
