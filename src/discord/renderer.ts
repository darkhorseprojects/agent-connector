import { type DiscordChunk, DiscordMessageStream } from "./format.ts";

const LIMIT = 2000;
const options = (chunk: DiscordChunk) => ({
  content: chunk.content,
  allowedMentions: { parse: [] as never[] },
});
type MessageOptions = ReturnType<typeof options>;
type RenderedMessage = Readonly<{ edit(options: MessageOptions): Promise<unknown> }>;
export type RenderTarget = Readonly<{ send(options: MessageOptions): Promise<RenderedMessage> }>;

export class DiscordRenderer {
  readonly #stream = new DiscordMessageStream(LIMIT);
  readonly #rendered: { message: RenderedMessage; chunk: DiscordChunk }[] = [];
  #shown = "";
  #lastUpdate = 0;

  constructor(readonly target: RenderTarget, readonly maximum?: number) {}

  async append(text: string): Promise<void> {
    if (!text) return;
    this.#stream.append(text);
    this.#shown += text;
    if (!this.#lastUpdate || performance.now() - this.#lastUpdate >= 750) {
      await this.#flush();
      this.#lastUpdate = performance.now();
    }
  }

  async write(text: string): Promise<void> {
    await this.finish();
    this.#shown = "";
    this.#lastUpdate = 0;
    if (!text.trim()) return;
    this.#stream.append(text);
    await this.finish();
  }

  async result(text: string): Promise<void> {
    await this.#flush();
    if (this.#shown && text.startsWith(this.#shown)) {
      this.#stream.append(text.slice(this.#shown.length));
    } else await this.write(text);
    await this.finish();
  }

  async finish(): Promise<void> {
    this.#stream.finish();
    await this.#flush();
  }

  async #flush(): Promise<void> {
    const chunks = this.#stream.snapshot();
    if (this.maximum !== undefined && chunks.length > this.maximum) {
      throw new Error("agent output exceeds configured message limit");
    }
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const previous = this.#rendered[index];
      if (previous?.chunk.content === chunk.content) continue;
      if (previous) {
        await previous.message.edit(options(chunk));
        previous.chunk = chunk;
      } else this.#rendered.push({ message: await this.target.send(options(chunk)), chunk });
    }
  }
}
