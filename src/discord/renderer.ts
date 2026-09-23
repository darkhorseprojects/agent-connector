import { Buffer } from "node:buffer";
import { type DiscordChunk, DiscordMessageStream } from "./format.ts";

const LIMIT = 2000;
const options = (chunk: DiscordChunk, edit = false) => ({
  content: chunk.content,
  allowedMentions: { parse: [] as never[] },
  ...(chunk.file ? { files: [{ attachment: Buffer.from(chunk.file), name: "agent-output.txt" }] } : {}),
  ...(edit ? { attachments: [] } : {}),
});
type MessageOptions = ReturnType<typeof options>;
type RenderedMessage = Readonly<{ edit(options: MessageOptions): Promise<unknown> }>;
export type RenderTarget = Readonly<{ send(options: MessageOptions): Promise<RenderedMessage> }>;

export class DiscordRenderer {
  readonly #stream = new DiscordMessageStream(LIMIT);
  readonly #messages: RenderedMessage[] = [];
  readonly #contents: DiscordChunk[] = [];

  constructor(readonly target: RenderTarget, readonly maximum?: number) {}

  async write(markdown: string): Promise<void> {
    if (!markdown.trim()) return;
    this.#stream.finish();
    this.#stream.append(markdown);
    this.#stream.finish();
    await this.#flush();
  }

  async delta(markdown: string): Promise<void> {
    if (!markdown) return;
    this.#stream.append(markdown);
    await this.#flush();
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
      const previous = this.#contents[index];
      if (
        previous?.content === chunk.content && previous.file?.length === chunk.file?.length &&
        (!chunk.file || chunk.file.every((byte, offset) => byte === previous.file![offset]))
      ) continue;
      if (this.#messages[index]) await this.#messages[index].edit(options(chunk, true));
      else this.#messages[index] = await this.target.send(options(chunk));
      this.#contents[index] = chunk;
    }
  }
}
