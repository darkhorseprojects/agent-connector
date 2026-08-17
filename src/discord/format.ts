export class DiscordMessageStream {
  readonly #maximum: number;
  readonly #finalized: string[] = [];
  #tail = "";
  #openFence: string | null = null;

  constructor(maximum = 2000) {
    validateMaximum(maximum);
    this.#maximum = maximum;
  }

  append(text: string): void {
    this.#tail += text;
    while (this.#tail.trim().length) {
      const part = takeChunk(this.#tail, this.#maximum, this.#openFence);
      if (part.remaining === undefined) break;
      this.#finalized.push(part.content);
      this.#tail = part.remaining;
      this.#openFence = part.open;
    }
  }

  get messageCount(): number {
    return this.#finalized.length + (this.#tail.trim().length ? 1 : 0);
  }

  snapshot(): string[] {
    const tail = this.#tail.trim();
    if (!tail) return [...this.#finalized];
    return [...this.#finalized, renderChunk(tail, this.#maximum, this.#openFence).content];
  }
}

export function splitDiscordMessage(text: string, maximum = 2000): string[] {
  const stream = new DiscordMessageStream(maximum);
  stream.append(text);
  return stream.snapshot();
}

export function deriveThreadTitle(request: string, maximum = 48): string {
  if (!Number.isSafeInteger(maximum) || maximum < 4) throw new RangeError("maximum must be at least 4");
  const title = request.replace(/[\r\n]+/g, " ").trim() || "Agent request";
  if (title.length <= maximum) return title;
  let end = maximum - 1;
  if (isLowSurrogate(title.charCodeAt(end))) end--;
  return `${title.slice(0, end).trimEnd()}…`;
}

type RenderedChunk = Readonly<{ content: string; open: string | null }>;
type TakenChunk = Readonly<{ content: string; open: string | null; remaining?: string }>;

function takeChunk(text: string, maximum: number, openFence: string | null): TakenChunk {
  const remaining = text.trimStart();
  const prefix = openFence ? `${openFence}\n` : "";
  const available = maximum - prefix.length - (openFence ? 4 : 0);
  let split = Math.min(remaining.trimEnd().length, available);
  if (split < remaining.trimEnd().length) {
    const boundary = Math.max(
      remaining.lastIndexOf("\n\n", split),
      remaining.lastIndexOf("\n", split),
      remaining.lastIndexOf(" ", split),
    );
    if (boundary >= Math.floor(available / 3)) split = boundary;
  }
  if (split > 0 && isLowSurrogate(remaining.charCodeAt(split))) split--;
  if (split <= 0) throw new Error("could not split Discord message");

  let piece = remaining.slice(0, split).trim();
  if (fenceState(piece, openFence) && prefix.length + piece.length + 4 > maximum) {
    split -= 4;
    if (split <= 0 || isLowSurrogate(remaining.charCodeAt(split))) split--;
    piece = remaining.slice(0, split).trim();
  }
  const rendered = renderChunk(piece, maximum, openFence);
  const tail = remaining.slice(split).trimStart();
  return {
    ...rendered,
    remaining: tail.trim().length ? tail : undefined,
  };
}

function renderChunk(piece: string, maximum: number, openFence: string | null): RenderedChunk {
  const prefix = openFence ? `${openFence}\n` : "";
  const open = fenceState(piece, openFence);
  const suffix = open ? "\n```" : "";
  const content = `${prefix}${piece}${suffix}`;
  if (content.length > maximum) throw new Error("Discord chunk exceeds maximum");
  return { content, open };
}

function fenceState(piece: string, initial: string | null): string | null {
  let open = initial;
  for (const match of piece.matchAll(/```([A-Za-z0-9_-]*)/g)) {
    if (open) open = null;
    else open = `\`\`\`${match[1]}`;
  }
  return open;
}

function validateMaximum(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 16) {
    throw new RangeError("maximum must be an integer of at least 16");
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}
