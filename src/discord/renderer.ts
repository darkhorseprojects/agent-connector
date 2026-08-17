import type { AgentEvent } from "../runtime/invoke.ts";
import { DiscordMessageStream, splitDiscordMessage } from "./format.ts";

const LIMIT = 2000;
const UPDATE_INTERVAL = 400;
const sendOptions = (content: string) => ({ content, allowedMentions: { parse: [] as never[] } });

export type RenderedMessage = Readonly<{
  edit(options: { content: string; allowedMentions: { parse: never[] } }): Promise<unknown>;
}>;

export type RenderTarget = Readonly<{
  send(options: { content: string; allowedMentions: { parse: never[] } }): Promise<RenderedMessage>;
}>;

type Block = {
  kind: "reasoning" | "response" | "fixed";
  stream: DiscordMessageStream;
  messages: RenderedMessage[];
  contents: string[];
  lastMutation: number;
  quoteAtLineStart: boolean;
  quoted: boolean;
};

export class DiscordRenderer {
  readonly #target: RenderTarget;
  readonly #maximumOutputMessages: number;
  readonly #blocks: Block[] = [];
  #sentMessages = 0;
  #current: Block | undefined;
  #last: Block | undefined;
  #store: Extract<AgentEvent, { type: "store" }> | undefined;
  #pending: Promise<void> = Promise.resolve();
  #finished: Promise<void> | undefined;

  constructor(target: RenderTarget, limits: Readonly<{ outputMessages: number }>) {
    if (!Number.isSafeInteger(limits.outputMessages) || limits.outputMessages <= 0) {
      throw new RangeError("outputMessages must be positive");
    }
    this.#target = target;
    this.#maximumOutputMessages = limits.outputMessages;
  }

  push(event: AgentEvent): Promise<void> {
    return this.#pending = this.#pending.then(() => this.#push(event));
  }

  async #push(event: AgentEvent): Promise<void> {
    if (this.#store) throw new Error("renderer received output after Store");
    if (event.type === "store") {
      await this.#flushCurrent();
      this.#store = event;
      this.#current = undefined;
      return;
    }
    if (event.type === "reasoning" || event.type === "response") {
      if (this.#current?.kind !== event.type) {
        await this.#flushCurrent();
        this.#current = this.#block(event.type);
      }
      this.#append(this.#current, event.text);
      await this.#render(this.#current, this.#current.messages.length === 0);
      return;
    }
    if (event.type === "reasoning_complete" || event.type === "response_complete") {
      await this.#flushCurrent();
      this.#last = this.#current;
      this.#current = undefined;
      return;
    }

    await this.#flushCurrent();
    this.#current = undefined;
    const language = event.type === "tool_call" ? "lua" : "text";
    const raw = event.type === "tool_call" ? event.code : event.text;
    const value = raw.replaceAll("```", "``\u200b`");
    const block = this.#block("fixed");
    block.stream.append(`\`\`\`${language}\n${value}\n\`\`\``);
    this.#checkMessages();
    await this.#render(block, true);
    this.#last = block;
  }

  get terminal(): boolean {
    return this.#store !== undefined;
  }

  finish(): Promise<void> {
    return this.#finished ??= this.#pending.then(() => this.#complete());
  }

  async #complete(): Promise<void> {
    if (!this.#store) throw new Error("renderer received no terminal Store event");
    const footer = this.#footer(this.#store);
    const response = this.#last?.kind === "response" && this.#last.messages.length ? this.#last : undefined;
    if (response) {
      const index = response.messages.length - 1;
      const content = `${response.contents[index]}\n${footer}`;
      if (content.length <= LIMIT) {
        await response.messages[index].edit(sendOptions(content));
        response.contents[index] = content;
        return;
      }
    }
    for (const chunk of splitDiscordMessage(footer, LIMIT)) await this.#send(chunk);
  }

  #block(kind: Block["kind"]): Block {
    const block: Block = {
      kind,
      stream: new DiscordMessageStream(LIMIT),
      messages: [],
      contents: [],
      lastMutation: Number.NEGATIVE_INFINITY,
      quoteAtLineStart: true,
      quoted: false,
    };
    this.#blocks.push(block);
    return block;
  }

  #append(block: Block, value: string): void {
    if (block.kind !== "reasoning") {
      block.stream.append(value);
      this.#checkMessages();
      return;
    }
    let rendered = "";
    for (const character of value) {
      if (block.quoteAtLineStart) {
        rendered += character === "\n" ? ">" : "> ";
        block.quoteAtLineStart = character === "\n";
      }
      rendered += character;
      block.quoted = true;
      if (character === "\n") block.quoteAtLineStart = true;
    }
    block.stream.append(rendered);
    this.#checkMessages();
  }

  async #flushCurrent(): Promise<void> {
    if (!this.#current) return;
    if (this.#current.kind === "reasoning" && this.#current.quoted && this.#current.quoteAtLineStart) {
      this.#current.stream.append(">");
      this.#current.quoteAtLineStart = false;
      this.#checkMessages();
    }
    await this.#render(this.#current, true);
  }

  async #render(block: Block, force: boolean): Promise<void> {
    const now = performance.now();
    if (!force && now - block.lastMutation < UPDATE_INTERVAL) return;
    const chunks = block.stream.snapshot();
    for (let index = 0; index < chunks.length; index++) {
      if (block.contents[index] === chunks[index]) continue;
      if (block.messages[index]) await block.messages[index].edit(sendOptions(chunks[index]));
      else block.messages[index] = await this.#send(chunks[index]);
      block.contents[index] = chunks[index];
    }
    block.lastMutation = now;
  }

  #checkMessages(): void {
    const projected = this.#blocks.reduce((total, block) => total + block.stream.messageCount, 0);
    if (projected > this.#maximumOutputMessages) {
      throw new Error("agent output exceeds configured message limit");
    }
  }

  async #send(content: string): Promise<RenderedMessage> {
    if (this.#sentMessages >= this.#maximumOutputMessages) {
      throw new Error("agent output exceeds configured message limit");
    }
    this.#sentMessages++;
    return await this.#target.send(sendOptions(content));
  }

  #footer(store: Extract<AgentEvent, { type: "store" }>): string {
    return `-# result #${store.result} · start #${store.start}`;
  }
}
