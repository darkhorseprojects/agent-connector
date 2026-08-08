import { Agent } from "@darkhorseprojects/portable-agents";
import type { Policy } from "./config.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function splitDiscordMessage(text: string, maxChars = 2000): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Try splitting on paragraph boundaries
    let splitIdx = remaining.lastIndexOf("\n\n", maxChars);
    if (splitIdx < maxChars * 0.3) {
      // Try splitting on single line break
      splitIdx = remaining.lastIndexOf("\n", maxChars);
    }
    if (splitIdx < maxChars * 0.3) {
      // Try splitting on sentence or space
      splitIdx = remaining.lastIndexOf(". ", maxChars);
      if (splitIdx > 0) splitIdx += 1;
      else splitIdx = remaining.lastIndexOf(" ", maxChars);
    }
    if (splitIdx <= 0) {
      splitIdx = maxChars;
    }

    const chunk = remaining.slice(0, splitIdx).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks.length > 0 ? chunks : [trimmed.slice(0, maxChars)];
}

export async function checkAgent(policy: Policy, signal?: AbortSignal): Promise<void> {
  const agent = Agent.directory(policy.directory, policy.entry, {
    authority: policy.authority,
  });
  await agent.check({ signal });
}

export async function runAgent(
  policy: Policy,
  authorId: string,
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  const agent = Agent.directory(policy.directory, policy.entry, {
    authority: policy.authority,
  });

  const inputBytes = encoder.encode(input);
  const outputBytes = await agent.run(inputBytes, {
    arguments: [authorId],
    memoryBytes: policy.memoryBytes,
    timeoutMs: policy.timeoutMs,
    signal,
  });

  if (outputBytes.length === 0) {
    return "";
  }

  let text: string;
  try {
    text = decoder.decode(outputBytes).trim();
  } catch (_e) {
    throw new Error("agent result is not valid UTF-8");
  }

  if (text.includes("\0")) {
    throw new Error("agent result contains NUL byte");
  }

  return text;
}
