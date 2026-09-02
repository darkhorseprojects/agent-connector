import type { AgentEvent } from "../agent.ts";
import { DiscordMessageStream } from "./format.ts";

const LIMIT = 2000;
const UPDATE_INTERVAL = 400;
const options = (content: string) => ({ content, allowedMentions: { parse: [] as never[] } });
type MessageOptions = ReturnType<typeof options>;
export type RenderedMessage = Readonly<{ edit(options: MessageOptions): Promise<unknown> }>;
export type RenderTarget = Readonly<{ send(options: MessageOptions): Promise<RenderedMessage> }>;
type Sent = { message: RenderedMessage; content: string };

export class DiscordRenderer {
  readonly #streams = [new DiscordMessageStream(LIMIT)];
  readonly #sent: Sent[] = [];
  #stream = this.#streams[0];
  #kind?: "reasoning" | "response";
  #lineStart = true;
  #mutation = Number.NEGATIVE_INFINITY;
  #terminal?: Extract<AgentEvent, { type: "store" | "done" }>;

  constructor(readonly target: RenderTarget, readonly maximum?: number) {}
  async push(event: AgentEvent): Promise<void> {
    if (event.type === "store" || event.type === "done") {
      this.#terminal = event;
      return await this.#render(true);
    }
    if (event.type === "reasoning" || event.type === "response") {
      if (this.#kind && this.#kind !== event.type) this.#separate();
      this.#kind = event.type;
      if (event.text.trim()) this.#stream.append(event.type === "reasoning" ? this.#reasoning(event.text) : event.text);
      return await this.#render(this.#sent.length === 0);
    }
    this.#kind = undefined;
    if (event.type === "reasoning_complete" || event.type === "response_complete") return this.#separate();
    this.#separate();
    const language = event.type === "tool_call" ? "lua" : "text";
    const value = (event.type === "tool_call" ? event.code : event.text).replaceAll("```", "``\u200b`");
    this.#stream.append(`\`\`\`${language}\n${value}\n\`\`\``);
    this.#separate();
    await this.#render(true);
  }
  #reasoning(value: string): string {
    const output = (this.#lineStart ? "> " : "") + value.replace(/\n(?!$)/g, "\n> ");
    this.#lineStart = value.endsWith("\n");
    return output;
  }
  #separate(): void {
    if (this.#stream.snapshot().length) {
      this.#stream = new DiscordMessageStream(LIMIT);
      this.#streams.push(this.#stream);
    }
    this.#lineStart = true;
  }
  async #render(force: boolean): Promise<void> {
    const now = performance.now();
    if (!force && now - this.#mutation < UPDATE_INTERVAL) return;
    const chunks = this.#streams.flatMap((stream) => stream.snapshot());
    if (this.maximum !== undefined && chunks.length > this.maximum) {
      throw new Error("agent output exceeds configured message limit");
    }
    for (const [index, content] of chunks.entries()) {
      const sent = this.#sent[index];
      if (sent?.content === content) continue;
      if (sent) {
        await sent.message.edit(options(content));
        sent.content = content;
      } else this.#sent[index] = { message: await this.target.send(options(content)), content };
    }
    this.#mutation = now;
  }
  async finish(): Promise<void> {
    if (!this.#terminal) throw new Error("renderer has no terminal event");
    if (this.#terminal.type === "store") {
      this.#separate();
      this.#stream.append(`-# result #${this.#terminal.result} · start #${this.#terminal.start}`);
    }
    await this.#render(true);
  }
}
