import { dirname, isAbsolute, join } from "@std/path";

export type RequestProfile = Readonly<{
  readyMs: number;
  activeMs: number;
  totalMs: number;
  observations: readonly {
    stage: string;
    childUs: number;
    receivedMs: number;
    logWriteMs?: number;
  }[];
  droppedStages: number;
  firstOutputReceivedMs?: number;
  firstSendStartedMs?: number;
  firstSendCompletedMs?: number;
  firstDeltaLogMs?: number;
}>;

export class OperatorLog {
  readonly #path: string;
  #pending: Promise<void> = Promise.resolve();
  #size?: number;

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
    return this.#write(JSON.stringify({ time: new Date().toISOString(), id, stage, elapsedMs, code }) + "\n");
  }

  recordProfile(id: string, profile: RequestProfile): Promise<void> {
    return this.#write(JSON.stringify({ time: new Date().toISOString(), id, profile }) + "\n");
  }

  #write(line: string): Promise<void> {
    const bytes = new TextEncoder().encode(line).length;
    const write = this.#pending.then(async () => {
      if (this.#size === undefined) {
        await Deno.mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        const file = await Deno.stat(this.#path).catch((error) => {
          if (error instanceof Deno.errors.NotFound) return undefined;
          throw error;
        });
        if (file && !file.isFile) throw new Error("operator log is not a file");
        if (file && Deno.build.os !== "windows") await Deno.chmod(this.#path, 0o600);
        this.#size = file?.size ?? 0;
      }
      if (this.#size + bytes > 8 * 1024 * 1024) {
        await Deno.remove(this.#path + ".1").catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
        await Deno.rename(this.#path, this.#path + ".1");
        this.#size = 0;
      }
      await Deno.writeTextFile(this.#path, line, { append: true, create: true, mode: 0o600 });
      this.#size += bytes;
    });
    this.#pending = write.catch(() => {});
    return write;
  }
}
