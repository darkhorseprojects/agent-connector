import type { AgentEvent } from "../agent.ts";
import { DiscordMessageStream } from "./format.ts";

const LIMIT = 2000;
const UPDATE_INTERVAL = 400;
const FOOTER_RESERVE = "\n-# result # · start #".length + String(Number.MAX_SAFE_INTEGER).length * 2;
const options = (content: string) => ({ content, allowedMentions: { parse: [] as never[] } });

export type RenderedMessage = Readonly<{
  edit(options: { content: string; allowedMentions: { parse: never[] } }): Promise<unknown>;
}>;
export type RenderTarget = Readonly<{
  send(options: { content: string; allowedMentions: { parse: never[] } }): Promise<RenderedMessage>;
}>;
type Sent = { message: RenderedMessage; content: string };
type Block = {
  kind: "reasoning" | "response" | "fixed";
  stream: DiscordMessageStream;
  sent: Sent[];
  mutation: number;
  lineStart: boolean;
};

export class DiscordRenderer {
  #sent = 0;
  #current: Block | undefined;
  #last: Sent | undefined;
  #terminal: Extract<AgentEvent, { type: "store" | "done" }> | undefined;

  constructor(readonly target: RenderTarget, readonly limits: Readonly<{ outputMessages: number }>) {}
  async push(event: AgentEvent): Promise<void> {
    if (event.type === "store" || event.type === "done") {
      await this.#flush();
      this.#terminal = event;
      this.#current = undefined;
    } else if (event.type === "reasoning" || event.type === "response") {
      if (this.#current?.kind !== event.type) {
        await this.#flush();
        this.#current = block(event.type);
      }
      this.#append(this.#current, event.text);
      await this.#render(this.#current, this.#current.sent.length === 0);
    } else if (event.type === "reasoning_complete" || event.type === "response_complete") {
      await this.#flush();
      this.#current = undefined;
    } else {
      await this.#flush();
      this.#current = undefined;
      const language = event.type === "tool_call" ? "lua" : "text";
      const value = (event.type === "tool_call" ? event.code : event.text).replaceAll("```", "``\u200b`");
      const fixed = block("fixed");
      fixed.stream.append(`\`\`\`${language}\n${value}\n\`\`\``);
      this.#check(fixed);
      await this.#render(fixed, true);
      this.#last = fixed.sent.at(-1);
    }
  }
  #append(block: Block, value: string): void {
    if (block.kind !== "reasoning") block.stream.append(value);
    else {
      const lines = value.split("\n");
      const trailing = lines.at(-1) === "";
      if (trailing) lines.pop();
      block.stream.append(
        lines.map((line, index) => index === 0 && !block.lineStart ? line : line ? `> ${line}` : ">").join("\n") +
          (trailing ? "\n" : ""),
      );
      block.lineStart = trailing;
    }
    this.#check(block);
  }
  async #flush(): Promise<void> {
    const block = this.#current;
    if (!block) return;
    if (block.kind === "reasoning" && block.lineStart) {
      block.stream.append(">");
      block.lineStart = false;
      this.#check(block);
    }
    await this.#render(block, true);
    this.#last = block.sent.at(-1);
  }
  async #render(block: Block, force: boolean): Promise<void> {
    const now = performance.now();
    if (!force && now - block.mutation < UPDATE_INTERVAL) return;
    const chunks = block.stream.snapshot();
    for (let index = 0; index < chunks.length; index++) {
      const sent = block.sent[index];
      if (sent?.content === chunks[index]) continue;
      if (sent) {
        await sent.message.edit(options(chunks[index]));
        sent.content = chunks[index];
      } else block.sent[index] = { message: await this.#send(chunks[index]), content: chunks[index] };
    }
    block.mutation = now;
  }
  #check(block: Block): void {
    const projected = this.#sent + block.stream.messageCount - block.sent.length;
    if (
      projected > this.limits.outputMessages ||
      projected === this.limits.outputMessages && block.stream.lastLength > LIMIT - FOOTER_RESERVE
    ) throw new Error("agent output exceeds configured message limit");
  }
  async #send(content: string): Promise<RenderedMessage> {
    if (this.#sent >= this.limits.outputMessages) throw new Error("agent output exceeds configured message limit");
    this.#sent++;
    return await this.target.send(options(content));
  }
  async finish(): Promise<void> {
    const terminal = this.#terminal!;
    if (terminal.type === "done") return;
    const footer = `-# result #${terminal.result} · start #${terminal.start}`;
    if (this.#last && this.#last.content.length + footer.length + 1 <= LIMIT) {
      this.#last.content += `\n${footer}`;
      await this.#last.message.edit(options(this.#last.content));
    } else await this.#send(footer);
  }
}

function block(kind: Block["kind"]): Block {
  return {
    kind,
    stream: new DiscordMessageStream(LIMIT),
    sent: [],
    mutation: Number.NEGATIVE_INFINITY,
    lineStart: true,
  };
}
