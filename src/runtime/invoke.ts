import { type Agent, type AgentError, check, run } from "@darkhorseprojects/portable-agents";
import { dirname, fromFileUrl, join } from "@std/path";
import { Effect, Schema, Stream } from "effect";
import type { Policy } from "../config.ts";

const Text = Schema.String.check(Schema.isPattern(/^[^\0]+$/));
const AnyText = Schema.String.check(Schema.isPattern(/^[^\0]*$/));
const Id = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Result = { result: Schema.optional(Id) };
const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Text }),
  Schema.Struct({ type: Schema.Literal("reasoning_complete"), ...Result }),
  Schema.Struct({ type: Schema.Literal("response"), text: Text }),
  Schema.Struct({ type: Schema.Literal("response_complete"), ...Result }),
  Schema.Struct({ type: Schema.Literal("tool_call"), call: Text, code: Text, ...Result }),
  Schema.Struct({ type: Schema.Literal("tool_result"), call: Text, text: AnyText, ok: Schema.Boolean, ...Result }),
  Schema.Struct({ type: Schema.Literal("store"), result: Id, start: Id }),
  Schema.Struct({ type: Schema.Literal("done"), durable: Schema.Literal(false) }),
]);
export type AgentEvent = Schema.Schema.Type<typeof Event>;
const decode = Schema.decodeUnknownSync(Event, { onExcessProperty: "error" });

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
    directory: policy.directory,
    entry: policy.entry,
    mounts: { ...policy.mounts, discord: discordSource() },
  };
}
function invocation(policy: Policy, frameBytes?: number, environment?: Readonly<Record<string, string>>) {
  return {
    executable: agentExecutable(),
    cwd: policy.directory,
    environment,
    frameBytes,
    luaMemory: policy.luaMemory,
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
  let terminal = false;
  const validated = run(agent(policy), input, invocation(policy, frameBytes, environment), [actor]).pipe(
    Stream.mapEffect((value) =>
      Effect.try({
        try: () => {
          const event = decode(value);
          if (terminal) throw new Error("agent output follows its terminal event");
          terminal = event.type === "store" || event.type === "done";
          return Object.freeze(event);
        },
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      })
    ),
  );
  return Stream.concat(
    validated,
    Stream.fromEffectDrain(Effect.sync(() => {
      if (!terminal) throw new Error("agent output has no terminal event");
    })),
  );
}
