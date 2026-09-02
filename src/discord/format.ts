type Fence = Readonly<{ marker: string; info: string }>;
type Chunk = Readonly<{ content: string; open: Fence | null; remaining?: string }>;

export class DiscordMessageStream {
  #text = "";
  constructor(readonly maximum = 2000) {
    if (!Number.isSafeInteger(maximum) || maximum < 16) {
      throw new RangeError("maximum must be an integer of at least 16");
    }
  }
  append(text: string): void {
    this.#text += text;
    if (!this.#text.trim()) this.#text = "";
  }
  snapshot(): string[] {
    const output: string[] = [];
    let remaining = this.#text;
    let open: Fence | null = null;
    while (remaining.trim()) {
      const chunk = take(remaining, this.maximum, open);
      output.push(chunk.content);
      remaining = chunk.remaining ?? "";
      open = chunk.open;
    }
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
    split -= Math.max(1, chunk.content.length - maximum);
    if (split > 0 && lowSurrogate(remaining.charCodeAt(split))) split--;
  }
  throw new Error("could not split Discord message");
}
function render(piece: string, initial: Fence | null): Chunk {
  let open = initial;
  for (const line of piece.split(/\r?\n/)) {
    const closing = open && line.match(/^ {0,3}(`+|~+)[ \t]*$/);
    if (closing && closing[1][0] === open!.marker[0] && closing[1].length >= open!.marker.length) open = null;
    else if (!open) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
      if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
        open = { marker: opening[1], info: opening[2] };
      }
    }
  }
  const prefix = initial ? `${initial.marker}${initial.info}\n` : "";
  return { content: `${prefix}${piece}${open ? `\n${open.marker}` : ""}`, open };
}
const lowSurrogate = (code: number) => code >= 0xDC00 && code <= 0xDFFF;
