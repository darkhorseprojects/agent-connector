import { DiscordMessageStream } from "./format.ts";

const LIMIT = 2000;
const options = (content: string) => ({ content, allowedMentions: { parse: [] as never[] } });
type MessageOptions = ReturnType<typeof options>;
type RenderedMessage = Readonly<{ edit(options: MessageOptions): Promise<unknown> }>;
export type RenderTarget = Readonly<{ send(options: MessageOptions): Promise<RenderedMessage> }>;

export class DiscordRenderer {
  readonly #stream = new DiscordMessageStream(LIMIT);
  readonly #messages: RenderedMessage[] = [];
  readonly #contents: string[] = [];
  #wrote = false;

  constructor(readonly target: RenderTarget, readonly maximum?: number) {}

  async write(markdown: string): Promise<void> {
    if (!markdown.trim()) return;
    this.#stream.append(`${this.#wrote ? "\n\n" : ""}${markdown}`);
    this.#wrote = true;
    const chunks = this.#stream.snapshot();
    if (this.maximum !== undefined && chunks.length > this.maximum) {
      throw new Error("agent output exceeds configured message limit");
    }
    for (let index = 0; index < chunks.length; index++) {
      if (this.#contents[index] === chunks[index]) continue;
      if (this.#messages[index]) await this.#messages[index].edit(options(chunks[index]));
      else this.#messages[index] = await this.target.send(options(chunks[index]));
      this.#contents[index] = chunks[index];
    }
  }
}
