import { Agent } from "@darkhorseprojects/portable-agents";
import type { Policy } from "./config.ts";
import { join } from "@std/path";

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

const DISCORD_LUA_SOURCE = `local discord = {}

function discord.format(message)
    if not message then return "" end
    local content = message.content or ""
    if type(content) ~= "string" then content = tostring(content or "") end
    content = content:gsub("^%s+", ""):gsub("%s+$", "")
    return content
end

function discord.title(request, response)
    if not request or request == "" then return "Agent Conversation" end
    local clean = request:gsub("[\r\n]+", " "):gsub("^%s+", ""):gsub("%s+$", "")
    local simplified = clean:gsub("^[Hh]ey,?%s*", ""):gsub("^[Hh]ello,?%s*", ""):gsub("^[Yy]o,?%s*", "")
    simplified = simplified:gsub("^[Ww]hat%s+is%s+in%s+", ""):gsub("^[Ww]hats%s+in%s+", ""):gsub("^[Ww]hat%s+is%s+", "")
    simplified = simplified:gsub("^[Cc]an%s+you%s+", ""):gsub("^[Tt]ell%s+me%s+about%s+", ""):gsub("^[Pp]lease%s+", "")
    if simplified == "" then simplified = clean end
    simplified = simplified:sub(1, 1):upper() .. simplified:sub(2)
    if #simplified > 48 then simplified = simplified:sub(1, 45) .. "..." end
    return simplified
end

return discord
`;

async function ensureInjectedDiscordModule(directory: string): Promise<string[]> {
  const targetPath = join(directory, "discord.lua");
  try {
    await Deno.writeTextFile(targetPath, DISCORD_LUA_SOURCE);
  } catch (_e) {}
  return ["discord.lua"];
}

export async function checkAgent(policy: Policy, signal?: AbortSignal): Promise<void> {
  const injected = await ensureInjectedDiscordModule(policy.directory);
  const authority = Array.from(new Set([...policy.authority, ...injected]));
  const agent = Agent.directory(policy.directory, policy.entry, { authority });
  await agent.check({ signal });
}

export async function runAgent(
  policy: Policy,
  authorId: string,
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  const injected = await ensureInjectedDiscordModule(policy.directory);
  const authority = Array.from(new Set([...policy.authority, ...injected]));
  const agent = Agent.directory(policy.directory, policy.entry, { authority });

  const inputBytes = encoder.encode(input);
  const outputBytes = await agent.run(inputBytes, {
    arguments: [authorId, "discord"],
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
