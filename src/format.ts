/**
 * Splits long Discord messages into chunks of <= maxChars (default 2000),
 * intelligently preserving code block fences and paragraph boundaries.
 */
export function splitDiscordMessage(text: string, maxChars = 2000): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  let activeCodeFence: string | null = null;

  while (remaining.length > 0) {
    // If the previous chunk left an open code fence, prefix current chunk with that fence
    let prefix = "";
    if (activeCodeFence) {
      prefix = `${activeCodeFence}\n`;
    }

    const availableChars = maxChars - prefix.length;
    if (remaining.length <= availableChars) {
      chunks.push(`${prefix}${remaining}`);
      break;
    }

    // Try splitting on paragraph boundaries
    let splitIdx = remaining.lastIndexOf("\n\n", availableChars);
    if (splitIdx < availableChars * 0.3) {
      // Try splitting on single line break
      splitIdx = remaining.lastIndexOf("\n", availableChars);
    }
    if (splitIdx < availableChars * 0.3) {
      // Try splitting on sentence end
      splitIdx = remaining.lastIndexOf(". ", availableChars);
      if (splitIdx > 0) splitIdx += 1;
      else splitIdx = remaining.lastIndexOf(" ", availableChars);
    }
    if (splitIdx <= 0) {
      splitIdx = availableChars;
    }

    let piece = remaining.slice(0, splitIdx).trim();

    // Check code fence parity in this piece
    const codeBlockMatches = piece.match(/```[a-zA-Z0-9_-]*/g) || [];
    let isFenceOpen = activeCodeFence !== null;
    let latestFence: string = activeCodeFence || "```";

    for (const match of codeBlockMatches) {
      if (isFenceOpen) {
        isFenceOpen = false;
      } else {
        isFenceOpen = true;
        latestFence = match;
      }
    }

    // If piece ends inside an open code block, close it for this chunk
    let suffix = "";
    if (isFenceOpen) {
      suffix = "\n```";
      activeCodeFence = latestFence;
    } else {
      activeCodeFence = null;
    }

    chunks.push(`${prefix}${piece}${suffix}`);
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks.length > 0 ? chunks : [trimmed.slice(0, maxChars)];
}

/**
 * Derives a concise, contextual thread topic from the user request and response.
 */
export function deriveThreadTitle(request: string, maxLength = 48): string {
  if (!request || !request.trim()) return "Agent Conversation";
  const clean = request.replace(/[\r\n]+/g, " ").trim();

  // Strip conversational noise & greetings
  let topic = clean
    .replace(/^[Hh]ey,?[\s]+/i, "")
    .replace(/^[Hh]ello,?[\s]+/i, "")
    .replace(/^[Yy]o,?[\s]+/i, "")
    .replace(/^[Ww]hat(?:'s|\s+is)\s+(?:in\s+)?/i, "")
    .replace(/^[Cc]an\s+you\s+(?:please\s+)?/i, "")
    .replace(/^[Tt]ell\s+me\s+about\s+/i, "")
    .replace(/^[Pp]lease\s+/i, "")
    .trim();

  if (!topic) topic = clean;
  // Capitalize first letter
  topic = topic.charAt(0).toUpperCase() + topic.slice(1);

  if (topic.length > maxLength) {
    topic = topic.slice(0, maxLength - 3).trimEnd() + "...";
  }
  return topic;
}
