import { Agent } from "@darkhorseprojects/portable-agents";
import type { Policy } from "./config.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

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
    throw new Error("agent returned an empty result");
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

  const charCount = Array.from(text).length;
  if (charCount > 2000) {
    throw new Error(`agent result exceeds Discord message limit (${charCount} > 2000 chars)`);
  }

  return text;
}
