export type DiscordChunk = Readonly<{ content: string }>;

type Fence = Readonly<{ marker: string; opening: string }>;

export class DiscordMessageStream {
  readonly #completed: DiscordChunk[] = [];
  #pending = "";
  #fence?: Fence;

  constructor(readonly maximum = 2000) {
    if (!Number.isSafeInteger(maximum) || maximum < 16) {
      throw new RangeError("maximum must be an integer of at least 16");
    }
  }

  append(text: string): void {
    this.#pending += text;
    while (this.#preview().length > this.maximum) {
      const prefix = this.#fence ? `${this.#fence.opening}\n` : "";
      let budget = this.maximum - prefix.length - 1;
      let cut = 0;
      let content = "";
      let fence: Fence | undefined;
      do {
        if (budget < 1) throw new Error("code fence exceeds Discord message limit");
        const portion = this.#pending.slice(0, budget);
        const paragraphs = [...portion.matchAll(/\r?\n[ \t]*\r?\n/g)];
        const paragraph = paragraphs.at(-1);
        cut = paragraph ? paragraph.index! + paragraph[0].length : 0;
        if (cut < budget / 2) cut = portion.lastIndexOf("\n") + 1;
        if (cut < budget / 2) {
          const whitespace = [...portion.matchAll(/[ \t]+/g)].at(-1);
          cut = whitespace ? whitespace.index! + whitespace[0].length : 0;
        }
        if (cut < budget / 2) cut = budget;
        if (lowSurrogate(this.#pending.charCodeAt(cut))) cut--;
        if (!cut) throw new Error("code fence exceeds Discord message limit");
        const raw = this.#pending.slice(0, cut);
        fence = this.#fenceAfter(raw, this.#fence);
        content = prefix + raw + (fence ? `${raw.endsWith("\n") ? "" : "\n"}${fence.marker}` : "");
        budget -= content.length - this.maximum;
      } while (content.length > this.maximum);
      if (content.trim()) this.#completed.push({ content });
      this.#pending = this.#pending.slice(cut);
      this.#fence = fence;
    }
  }

  finish(): void {
    if (this.#pending.trim()) this.#completed.push({ content: this.#preview() });
    this.#pending = "";
    this.#fence = undefined;
  }

  snapshot(): DiscordChunk[] {
    return this.#pending.trim() ? [...this.#completed, { content: this.#preview() }] : [...this.#completed];
  }

  #preview(): string {
    const prefix = this.#fence ? `${this.#fence.opening}\n` : "";
    const fence = this.#fenceAfter(this.#pending, this.#fence, true);
    const content = prefix + this.#pending;
    return content + (fence ? `${content.endsWith("\n") ? "" : "\n"}${fence.marker}` : "");
  }

  #fenceAfter(text: string, previous?: Fence, final = false): Fence | undefined {
    let fence = previous;
    const lines = text.split("\n");
    const count = final ? lines.length : lines.length - 1;
    for (let index = 0; index < count; index++) {
      const line = lines[index].replace(/\r$/, "");
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (fence && closing && closing[1][0] === fence.marker[0] && closing[1].length >= fence.marker.length) {
        fence = undefined;
      } else if (!fence) {
        const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
        if (
          opening && (opening[1][0] !== "`" || !opening[2].includes("`")) &&
          opening[0].length + 2 * opening[1].length + 4 <= this.maximum
        ) fence = { marker: opening[1], opening: opening[0] };
      }
    }
    return fence;
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
