import { type Agent, type AgentError, check, run } from "@darkhorseprojects/portable-agents";
import { dirname, fromFileUrl, join } from "@std/path";
import { Effect, Schema, Stream } from "effect";
import type { Policy } from "../config.ts";

const Text = Schema.String.pipe(Schema.pattern(/^[^\0]+$/));
const AnyText = Schema.String.pipe(Schema.pattern(/^[^\0]*$/));
const Id = Schema.Number.pipe(Schema.int(), Schema.positive());
const Result = { result: Schema.optional(Id) };
const Event = Schema.Union(
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Text }),
  Schema.Struct({ type: Schema.Literal("reasoning_complete"), ...Result }),
  Schema.Struct({ type: Schema.Literal("response"), text: Text }),
  Schema.Struct({ type: Schema.Literal("response_complete"), ...Result }),
  Schema.Struct({ type: Schema.Literal("tool_call"), call: Text, code: Text, ...Result }),
  Schema.Struct({ type: Schema.Literal("tool_result"), call: Text, text: AnyText, ok: Schema.Boolean, ...Result }),
  Schema.Struct({ type: Schema.Literal("store"), result: Id, start: Id }),
  Schema.Struct({ type: Schema.Literal("done"), durable: Schema.Literal(false) }),
);
export type AgentEvent = Schema.Schema.Type<typeof Event>;
const decode = Schema.decodeUnknownSync(Event, { onExcessProperty: "error" });
type Protocol = {
  open?: "reasoning" | "response";
  mode?: "durable" | "temporary";
  outstanding: Set<string>;
  lastId?: number;
  last?: "reasoning" | "response" | "tool_call" | "tool_result";
  terminal: boolean;
};

export function agentExecutable(): string {
  const name = Deno.build.os === "windows" ? "agent.exe" : "agent";
  return Deno.build.standalone
    ? join(dirname(Deno.execPath()), name)
    : fromFileUrl(new URL("../../../portable-agents/zig-out/bin/" + name, import.meta.url));
}
function discordSource(): string {
  return Deno.build.standalone
    ? join(dirname(Deno.execPath()), "discord.md")
    : fromFileUrl(new URL("../../discord.md", import.meta.url));
}
function agent(policy: Policy): Agent {
  return {
    target: { directory: policy.directory },
    entry: policy.entry,
    mounts: { ...policy.mounts, discord: discordSource() },
    trust: [...policy.trust, "discord"],
  };
}
function invocation(policy: Policy, frameBytes?: number, environment?: Readonly<Record<string, string>>) {
  return {
    executable: agentExecutable(),
    cwd: policy.directory,
    environment,
    frameBytes,
    limits: { luaMemory: policy.luaMemory, processMemory: policy.processMemory, wallTime: policy.wallTime },
  };
}
export function checkAgent(policy: Policy): Effect.Effect<unknown, AgentError> {
  return check(agent(policy), invocation(policy));
}

export function runAgent(
  policy: Policy,
  actor: string,
  input: string,
  frameBytes: number,
  environment?: Readonly<Record<string, string>>,
): Stream.Stream<AgentEvent, AgentError | Error> {
  const state: Protocol = { outstanding: new Set(), terminal: false };
  const validated = run(agent(policy), input, invocation(policy, frameBytes, environment), [actor]).pipe(
    Stream.mapEffect((value) =>
      Effect.try({
        try: () => {
          const event = decode(value);
          sequence(state, event);
          return Object.freeze(event);
        },
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      })
    ),
  );
  return Stream.concat(
    validated,
    Stream.execute(Effect.sync(() => {
      if (!state.terminal) throw new Error("agent output has no terminal event");
    })),
  );
}

function sequence(state: Protocol, event: AgentEvent): void {
  if (state.terminal) throw new Error("agent output follows its terminal event");
  if (event.type === "reasoning" || event.type === "response") {
    if (state.outstanding.size || state.open && state.open !== event.type) {
      throw new Error("agent text stream overlaps other work");
    }
    state.open = event.type;
    return;
  }
  if (event.type === "reasoning_complete" || event.type === "response_complete") {
    const kind = event.type === "reasoning_complete" ? "reasoning" : "response";
    if (state.open !== kind) throw new Error(`${event.type} has no matching stream`);
    state.open = undefined;
    completion(state, event, kind);
    return;
  }
  if (event.type === "tool_call") {
    if (state.open || state.outstanding.has(event.call)) throw new Error("invalid tool_call sequence");
    state.outstanding.add(event.call);
    completion(state, event, "tool_call");
    return;
  }
  if (event.type === "tool_result") {
    if (!state.outstanding.delete(event.call)) throw new Error("tool_result has no matching tool_call");
    completion(state, event, "tool_result");
    return;
  }
  if (state.open || state.outstanding.size || state.last !== "response") {
    throw new Error("terminal event precedes completion");
  }
  if (event.type === "store") {
    if (state.mode !== "durable" || event.result !== state.lastId || event.start > event.result) {
      throw new Error("Store does not match final response");
    }
  } else if (state.mode !== "temporary") throw new Error("Done does not match temporary completion");
  state.terminal = true;
}
function completion(
  state: Protocol,
  event: Exclude<AgentEvent, { type: "reasoning" | "response" | "store" | "done" }>,
  kind: Protocol["last"],
): void {
  const mode = event.result === undefined ? "temporary" : "durable";
  if (state.mode && state.mode !== mode) throw new Error("agent mixed durable and temporary events");
  if (event.result !== undefined) {
    if (state.lastId !== undefined && event.result <= state.lastId) throw new Error("result identifiers must increase");
    state.lastId = event.result;
  }
  state.mode = mode;
  state.last = kind;
}
