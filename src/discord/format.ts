export class DiscordMessageStream {
  readonly #maximum: number;
  readonly #finalized: string[] = [];
  #tail = "";
  #openFence: Fence | null = null;

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
    const rendered = renderChunk(tail, this.#openFence).content;
    if (rendered.length > this.#maximum) throw new Error("Discord chunk exceeds maximum");
    return [...this.#finalized, rendered];
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

type Fence = Readonly<{ marker: string; info: string }>;
type RenderedChunk = Readonly<{ content: string; open: Fence | null }>;
type TakenChunk = Readonly<{ content: string; open: Fence | null; remaining?: string }>;

function takeChunk(text: string, maximum: number, openFence: Fence | null): TakenChunk {
  const remaining = text.trimStart();
  const prefix = openFence ? `${openFence.marker}${openFence.info}\n` : "";
  const closing = openFence ? openFence.marker.length + 1 : 0;
  const available = maximum - prefix.length - closing;
  if (available <= 0) throw new Error("could not split Discord message");
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

  let rendered: RenderedChunk;
  while (true) {
    const piece = remaining.slice(0, split).trim();
    rendered = renderChunk(piece, openFence);
    if (rendered.content.length <= maximum) break;
    split -= rendered.content.length - maximum;
    if (split > 0 && isLowSurrogate(remaining.charCodeAt(split))) split--;
    if (split <= 0) throw new Error("could not split Discord message");
  }
  const tail = remaining.slice(split).trimStart();
  return { ...rendered, remaining: tail.trim().length ? tail : undefined };
}

function renderChunk(piece: string, openFence: Fence | null): RenderedChunk {
  const prefix = openFence ? `${openFence.marker}${openFence.info}\n` : "";
  const open = fenceState(piece, openFence);
  const suffix = open ? `\n${open.marker}` : "";
  return { content: `${prefix}${piece}${suffix}`, open };
}

function fenceState(piece: string, initial: Fence | null): Fence | null {
  let open = initial;
  for (const line of piece.split(/\r?\n/)) {
    if (open) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (closing && closing[1][0] === open.marker[0] && closing[1].length >= open.marker.length) open = null;
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
    if (!opening || opening[1][0] === "`" && opening[2].includes("`")) continue;
    open = Object.freeze({ marker: opening[1], info: opening[2] });
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
