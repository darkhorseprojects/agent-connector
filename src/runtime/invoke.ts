import { s } from "@sapphire/shapeshift";
import { type Agent, check, run } from "@darkhorseprojects/portable-agents";
import { dirname, fromFileUrl, join } from "@std/path";
import type { Policy } from "../config.ts";

export const PORTABLE_AGENTS_VERSION = "1.0.0";

export function agentExecutable(): string {
  if (Deno.build.standalone) return join(dirname(Deno.execPath()), Deno.build.os === "windows" ? "agent.exe" : "agent");
  return fromFileUrl(
    new URL(
      `../../../portable-agents/zig-out/bin/${Deno.build.os === "windows" ? "agent.exe" : "agent"}`,
      import.meta.url,
    ),
  );
}

export async function verifyAgentVersion(): Promise<void> {
  const command = new Deno.Command(agentExecutable(), {
    args: ["--version"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const actual = new TextDecoder().decode(output.stdout).trim();
  if (!output.success || actual !== `agent ${PORTABLE_AGENTS_VERSION}`) {
    const diagnostic = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `Portable Agents ${PORTABLE_AGENTS_VERSION} is required at ${agentExecutable()}: ${
        diagnostic || actual || `status ${output.code}`
      }`,
    );
  }
}

export type AgentEvent =
  | Readonly<{ type: "reasoning"; text: string }>
  | Readonly<{ type: "reasoning_complete"; result: number }>
  | Readonly<{ type: "response"; text: string }>
  | Readonly<{ type: "response_complete"; result: number }>
  | Readonly<{ type: "tool_call"; code: string; result: number }>
  | Readonly<{ type: "tool_result"; text: string; ok: boolean; result: number }>
  | Readonly<{ type: "store"; result: number; start: number }>;

function agent(policy: Policy): Agent {
  return {
    target: { directory: policy.directory },
    entryPath: policy.entry,
    mounts: policy.mounts,
    trustedModules: policy.trustedModules,
  };
}

export async function checkAgent(policy: Policy, signal?: AbortSignal): Promise<void> {
  await check(agent(policy), { executable: agentExecutable(), luaMemory: policy.luaMemory, signal });
}

export function runAgent(
  policy: Policy,
  actor: string,
  input: string,
  maximumEventBytes: number,
  signal?: AbortSignal,
  environment?: Readonly<Record<string, string>>,
): AsyncIterable<AgentEvent> {
  return parseAgentOutput(
    run(agent(policy), new TextEncoder().encode(input), {
      arguments: [actor],
      executable: agentExecutable(),
      environment,
      cwd: policy.directory,
      luaMemory: policy.luaMemory,
      signal,
    }),
    maximumEventBytes,
  );
}

export async function* parseAgentOutput(
  output: AsyncIterable<Uint8Array>,
  maximumEventBytes: number,
): AsyncIterable<AgentEvent> {
  if (!Number.isSafeInteger(maximumEventBytes) || maximumEventBytes <= 0) {
    throw new RangeError("maximumEventBytes must be positive");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  let terminal = false;
  const protocol: ProtocolState = { awaitingToolResult: false };
  try {
    for await (const chunk of output) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError("agent output chunk is not bytes");
      if (chunk.includes(0)) throw new Error("agent output contains NUL byte");
      let offset = 0;
      while (offset < chunk.length) {
        const ending = chunk.indexOf(0x0A, offset);
        const end = ending < 0 ? chunk.length : ending;
        const part = chunk.subarray(offset, end);
        if (part.length) parts.push(part);
        lineBytes += part.length;
        if (lineBytes > maximumEventBytes) throw new Error("agent event exceeds configured byte limit");
        if (ending < 0) break;

        let line = concatenate(parts, lineBytes);
        if (line.at(-1) === 0x0D) line = line.subarray(0, line.length - 1);
        if (!line.length) throw new Error("agent output contains an empty event line");
        if (terminal) throw new Error("agent output follows the terminal Store event");
        const event = parseEvent(decoder.decode(line));
        sequence(protocol, event);
        terminal = event.type === "store";
        parts = [];
        lineBytes = 0;
        offset = ending + 1;
        yield event;
      }
    }
  } catch (error) {
    if (error instanceof TypeError && /encoded data|UTF-8/i.test(error.message)) {
      throw new Error("agent output is not valid UTF-8", { cause: error });
    }
    throw error;
  }
  if (lineBytes) throw new Error("agent output ends with an incomplete event line");
  if (!terminal) throw new Error("agent output has no terminal Store event");
}

type StreamKind = "reasoning" | "response";
type DurableKind = StreamKind | "tool_call" | "tool_result";
type DurableItem = Readonly<{ kind: DurableKind; id: number }>;

type ProtocolState = {
  open?: StreamKind;
  awaitingToolResult: boolean;
  last?: DurableItem;
};

function sequence(state: ProtocolState, event: AgentEvent): void {
  if (event.type === "reasoning" || event.type === "response") {
    if (state.awaitingToolResult) throw new Error("agent output continues before tool_result");
    if (state.open !== undefined && state.open !== event.type) {
      throw new Error(`${event.type} starts before ${state.open}_complete`);
    }
    state.open = event.type;
    return;
  }

  if (event.type === "reasoning_complete" || event.type === "response_complete") {
    const kind = event.type === "reasoning_complete" ? "reasoning" : "response";
    if (state.open !== kind) throw new Error(`${event.type} has no matching ${kind} stream`);
    result(state, event.result, kind);
    state.open = undefined;
    return;
  }

  if (event.type === "tool_call") {
    if (state.open !== undefined) throw new Error(`tool_call occurs before ${state.open}_complete`);
    if (state.awaitingToolResult) throw new Error("tool_call occurs before tool_result");
    result(state, event.result, "tool_call");
    state.awaitingToolResult = true;
    return;
  }

  if (event.type === "tool_result") {
    if (!state.awaitingToolResult) throw new Error("tool_result has no matching tool_call");
    result(state, event.result, "tool_result");
    state.awaitingToolResult = false;
    return;
  }

  if (state.open !== undefined) throw new Error(`Store occurs before ${state.open}_complete`);
  if (!state.last) throw new Error("Store has no completed durable item");
  if (event.result !== state.last.id) throw new Error("Store result does not match the latest completed item");
  if (event.start > event.result) throw new Error("Store result precedes Store start");
}

function result(state: ProtocolState, id: number, kind: DurableKind): void {
  if (state.last && id <= state.last.id) throw new Error("agent result identifiers must increase");
  state.last = Object.freeze({ kind, id });
}

function concatenate(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const eventText = s.string().lengthGreaterThan(0).regex(/^[^\0]+$/);
const resultId = s.number().safeInt().greaterThan(0);
const eventSchemas = {
  reasoning: s.object({ type: s.literal("reasoning"), text: eventText }).strict(),
  reasoning_complete: s.object({ type: s.literal("reasoning_complete"), result: resultId }).strict(),
  response: s.object({ type: s.literal("response"), text: eventText }).strict(),
  response_complete: s.object({ type: s.literal("response_complete"), result: resultId }).strict(),
  tool_call: s.object({ type: s.literal("tool_call"), code: eventText, result: resultId }).strict(),
  tool_result: s.object({
    type: s.literal("tool_result"),
    text: s.string().regex(/^[^\0]*$/),
    ok: s.boolean(),
    result: resultId,
  }).strict(),
  store: s.object({ type: s.literal("store"), result: resultId, start: resultId }).strict(),
} as const;

function parseEvent(line: string): AgentEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("agent event is not valid JSON", { cause: error });
  }
  const type = value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { type?: unknown }).type
    : undefined;
  if (typeof type !== "string" || !Object.hasOwn(eventSchemas, type)) {
    throw new TypeError(`unknown agent event type: ${String(type)}`);
  }
  const schema = eventSchemas[type as keyof typeof eventSchemas] as { parse(value: unknown): unknown };
  return Object.freeze(schema.parse(value) as AgentEvent);
}
