type Fence = Readonly<{ marker: string; info: string }>;
type Chunk = Readonly<{ content: string; open: Fence | null; remaining?: string }>;

export class DiscordMessageStream {
  readonly #finalized: string[] = [];
  #tail = "";
  #open: Fence | null = null;
  #snapshot: string[] | undefined;

  constructor(readonly maximum = 2000) {
    validate(maximum);
  }
  append(text: string): void {
    this.#snapshot = undefined;
    this.#tail += text;
    while (this.#tail.trim()) {
      const chunk = take(this.#tail, this.maximum, this.#open);
      if (chunk.remaining === undefined) break;
      this.#finalized.push(chunk.content);
      this.#tail = chunk.remaining;
      this.#open = chunk.open;
    }
  }
  get messageCount(): number {
    return this.#finalized.length + Number(Boolean(this.#tail.trim()));
  }
  get lastLength(): number {
    return this.snapshot().at(-1)?.length ?? 0;
  }
  snapshot(): string[] {
    if (!this.#snapshot) {
      const tail = this.#tail.trim();
      const content = tail ? render(tail, this.#open).content : undefined;
      if (content && content.length > this.maximum) throw new Error("Discord chunk exceeds maximum");
      this.#snapshot = content ? [...this.#finalized, content] : [...this.#finalized];
    }
    return [...this.#snapshot];
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

function take(text: string, maximum: number, open: Fence | null): Chunk {
  const remaining = text.trimStart();
  const prefix = open ? `${open.marker}${open.info}\n` : "";
  const available = maximum - prefix.length - (open ? open.marker.length + 1 : 0);
  if (available <= 0) throw new Error("could not split Discord message");
  const length = remaining.trimEnd().length;
  let split = Math.min(length, available);
  if (split < length) {
    const boundary = Math.max(
      remaining.lastIndexOf("\n\n", split),
      remaining.lastIndexOf("\n", split),
      remaining.lastIndexOf(" ", split),
    );
    if (boundary >= Math.floor(available / 3)) split = boundary;
  }
  if (split > 0 && lowSurrogate(remaining.charCodeAt(split))) split--;
  while (split > 0) {
    const chunk = render(remaining.slice(0, split).trim(), open);
    if (chunk.content.length <= maximum) {
      const tail = remaining.slice(split).trimStart();
      return { ...chunk, remaining: tail.trim() ? tail : undefined };
    }
    split -= chunk.content.length - maximum;
    if (split > 0 && lowSurrogate(remaining.charCodeAt(split))) split--;
  }
  throw new Error("could not split Discord message");
}

function render(piece: string, initial: Fence | null): Chunk {
  let open = initial;
  for (const line of piece.split(/\r?\n/)) {
    if (open) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (closing && closing[1][0] === open.marker[0] && closing[1].length >= open.marker.length) open = null;
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
      if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
        open = { marker: opening[1], info: opening[2] };
      }
    }
  }
  const prefix = initial ? `${initial.marker}${initial.info}\n` : "";
  return { content: `${prefix}${piece}${open ? `\n${open.marker}` : ""}`, open };
}
function validate(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 16) throw new RangeError("maximum must be an integer of at least 16");
}
function lowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}
