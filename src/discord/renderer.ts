import { DiscordMessageStream } from "./format.ts";

const options = (content: string) => ({ content, allowedMentions: { parse: [] as never[] } });
export type RenderTarget = Readonly<{ send(message: ReturnType<typeof options>): Promise<unknown> }>;

export class DiscordRenderer {
  #pending = "";
  #model = "";
  #lastTurn = "";
  #sent = 0;

  constructor(readonly target: RenderTarget, readonly maximum?: number) {}

  append(text: string): void {
    this.#pending += text;
    this.#model += text;
  }

  write(text: string): void {
    if (text.trim()) this.#pending += (this.#pending.trim() ? "\n\n" : "") + text;
  }

  async turn(): Promise<void> {
    await this.#send(this.#pending);
    this.#lastTurn = this.#model;
    this.#pending = "";
    this.#model = "";
  }

  async result(text: string): Promise<void> {
    if (this.#pending.trim()) await this.turn();
    const marker = text.indexOf("\n\n-# result #");
    const body = marker < 0 ? text : text.slice(0, marker);
    if (this.#lastTurn && this.#lastTurn.endsWith(body)) text = marker < 0 ? "" : text.slice(marker).trim();
    await this.#send(text);
  }

  async #send(text: string): Promise<void> {
    if (!text.trim()) return;
    const chunks = new DiscordMessageStream();
    chunks.append(text);
    chunks.finish();
    const messages = chunks.snapshot();
    if (this.maximum !== undefined && this.#sent + messages.length > this.maximum) {
      throw new Error("agent output exceeds configured message limit");
    }
    for (const message of messages) {
      await this.target.send(options(message.content));
      this.#sent++;
    }
  }
}
