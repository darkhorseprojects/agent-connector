export type DiscordChunk = Readonly<{ content: string; file?: Uint8Array }>;

export class DiscordMessageStream {
  readonly #completed: DiscordChunk[] = [];
  #pending = "";

  constructor(readonly maximum = 2000) {
    if (!Number.isSafeInteger(maximum) || maximum < 16) {
      throw new RangeError("maximum must be an integer of at least 16");
    }
  }

  append(text: string): void {
    this.#pending += text;
  }

  finish(): void {
    this.#completed.push(...this.#format(this.#pending));
    this.#pending = "";
  }

  snapshot(): DiscordChunk[] {
    return [...this.#completed, ...this.#format(this.#pending)];
  }

  #format(text: string): DiscordChunk[] {
    if (!text.trim()) return [];
    const blocks: { text: string; separator: string }[] = [];
    let start = 0;
    let cursor = 0;
    let separator = "";
    let fence: string | undefined;
    for (const raw of text.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (fence && closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
        fence = undefined;
      } else if (!fence) {
        const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
        if (opening && (opening[1][0] !== "`" || !opening[2].includes("`"))) fence = opening[1];
      }
      if (!fence && line.trim() === "" && cursor > start) {
        blocks.push({ text: text.slice(start, cursor - 1), separator });
        separator = text.slice(cursor - 1, cursor + raw.length + 1);
        start = cursor + raw.length + 1;
      }
      cursor += raw.length + 1;
    }
    blocks.push({ text: text.slice(start), separator });
    const output: DiscordChunk[] = [];
    let current = "";
    for (const block of blocks) {
      if (!block.text.trim()) continue;
      if (block.text.length > this.maximum) {
        if (current) output.push({ content: current });
        output.push({
          content: "Text attached.",
          file: new TextEncoder().encode(block.text),
        });
        current = "";
      } else if (!current) {
        current = block.text;
      } else if (current.length + block.separator.length + block.text.length <= this.maximum) {
        current += block.separator + block.text;
      } else {
        output.push({ content: current });
        current = block.text;
      }
    }
    if (current) output.push({ content: current });
    return output;
  }
}

export function deriveThreadTitle(request: string, maximum = 48): string {
  if (!Number.isSafeInteger(maximum) || maximum < 4) throw new RangeError("maximum must be at least 4");
  const title = request.replace(/[\r\n]+/g, " ").trim() || "Agent request";
  if (title.length <= maximum) return title;
  let end = maximum - 1;
  if (lowSurrogate(title.charCodeAt(end))) end--;
  return `${title.slice(0, end).trimEnd()}…`;
}

const lowSurrogate = (code: number) => code >= 0xDC00 && code <= 0xDFFF;
