import { Agent } from "@darkhorseprojects/portable-agents";
import type { Policy } from "../config.ts";

export type AgentEvent =
  | Readonly<{ type: "reasoning"; text: string }>
  | Readonly<{ type: "reasoning_complete"; result: number }>
  | Readonly<{ type: "response"; text: string }>
  | Readonly<{ type: "response_complete"; result: number }>
  | Readonly<{ type: "tool_call"; code: string; result: number }>
  | Readonly<{ type: "tool_result"; text: string; ok: boolean; result: number }>
  | Readonly<{ type: "store"; result: number; start: number }>;

function agent(policy: Policy): Agent {
  return Agent.directory(policy.directory, policy.entry, {
    register: policy.register,
    authorize: policy.authorize,
  });
}

export async function checkAgent(policy: Policy, signal?: AbortSignal): Promise<void> {
  await agent(policy).check(signal);
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
    agent(policy).run(new TextEncoder().encode(input), {
      arguments: [actor],
      environment,
      cwd: policy.directory,
      memory: policy.memory,
      timeout: policy.timeout,
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
  const protocol: ProtocolState = {
    awaitingToolResult: false,
    lastResult: 0,
  };
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

type ProtocolState = {
  open?: StreamKind;
  awaitingToolResult: boolean;
  lastResult: number;
  finalResponse?: number;
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
    result(state, event.result);
    state.open = undefined;
    if (kind === "response") state.finalResponse = event.result;
    return;
  }

  if (event.type === "tool_call") {
    if (state.open !== undefined) throw new Error(`tool_call occurs before ${state.open}_complete`);
    if (state.awaitingToolResult) throw new Error("tool_call occurs before tool_result");
    result(state, event.result);
    state.awaitingToolResult = true;
    return;
  }

  if (event.type === "tool_result") {
    if (!state.awaitingToolResult) throw new Error("tool_result has no matching tool_call");
    result(state, event.result);
    state.awaitingToolResult = false;
    return;
  }

  if (state.open !== undefined) throw new Error(`Store occurs before ${state.open}_complete`);
  if (state.awaitingToolResult) throw new Error("Store occurs before tool_result");
  if (state.finalResponse === undefined) throw new Error("Store has no completed response");
  if (event.result !== state.finalResponse) throw new Error("Store result does not match the final response");
}

function result(state: ProtocolState, value: number): void {
  if (value <= state.lastResult) throw new Error("agent result identifiers must increase");
  state.lastResult = value;
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

function parseEvent(line: string): AgentEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("agent event is not valid JSON", { cause: error });
  }
  const event = object(value, "agent event");
  if (event.type === "reasoning" || event.type === "response") {
    exact(event, ["type", "text"]);
    return Object.freeze({ type: event.type, text: text(event.text, `${event.type}.text`, false) });
  }
  if (event.type === "reasoning_complete" || event.type === "response_complete") {
    exact(event, ["type", "result"]);
    return Object.freeze({ type: event.type, result: identifier(event.result, `${event.type}.result`) });
  }
  if (event.type === "tool_call") {
    exact(event, ["type", "code", "result"]);
    return Object.freeze({
      type: "tool_call",
      code: text(event.code, "tool_call.code", false),
      result: identifier(event.result, "tool_call.result"),
    });
  }
  if (event.type === "tool_result") {
    exact(event, ["type", "text", "ok", "result"]);
    if (typeof event.ok !== "boolean") throw new TypeError("tool_result.ok must be boolean");
    return Object.freeze({
      type: "tool_result",
      text: text(event.text, "tool_result.text", true),
      ok: event.ok,
      result: identifier(event.result, "tool_result.result"),
    });
  }
  if (event.type === "store") {
    exact(event, ["type", "result", "start"]);
    const result = identifier(event.result, "store.result");
    const start = identifier(event.start, "store.start");
    if (result < start) throw new TypeError("store.result precedes store.start");
    return Object.freeze({ type: "store", result, start });
  }
  throw new TypeError(`unknown agent event type: ${String(event.type)}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`unknown ${String(value.type)} event key: ${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${String(value.type)} event is missing ${key}`);
  }
}

function text(value: unknown, name: string, empty: boolean): string {
  if (typeof value !== "string" || (!empty && !value) || value.includes("\0")) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function identifier(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value as number;
}
