import * as NodeChildProcessSpawner from "@effect/platform-node/child-process";
import * as NodeFileSystem from "@effect/platform-node/file-system";
import * as NodePath from "@effect/platform-node/path";
import { type Import, make as makeAgent } from "@darkhorseprojects/portable-agents";
import { dirname, fromFileUrl, join } from "@std/path";
import { Effect, Layer, Stream } from "effect";
import { invocationConfig, type InvocationContext, type Policy } from "./config.ts";
import type { DiscordGrant } from "./discord/rpc.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const processLayer = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, NodePath.layer),
);

export function agentExecutable(): string {
  const name = Deno.build.os === "windows" ? "agent.exe" : "agent";
  return Deno.build.standalone
    ? join(dirname(Deno.execPath()), name)
    : fromFileUrl(new URL("../../portable-agents/zig-out/bin/" + name, import.meta.url));
}

function discordSourceDir(): string {
  return Deno.build.standalone
    ? join(dirname(Deno.execPath()), "discord")
    : fromFileUrl(new URL("../package", import.meta.url));
}

function environment(policy: Policy) {
  return Object.fromEntries(
    policy.environment.flatMap((name) => {
      const value = Deno.env.get(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function makePolicyAgent(policy: Policy) {
  return makeAgent({
    executable: agentExecutable(),
    sourceDir: policy.sourceDir,
    entryModule: policy.entryModule,
    memoryBytes: policy.memoryBytes,
    instructions: policy.instructions,
    cwd: policy.directory,
    environment: environment(policy),
  });
}

export function checkAgent(policy: Policy) {
  return Effect.tryPromise({
    try: async () => {
      const output = await new Deno.Command(agentExecutable(), {
        args: ["check", policy.sourceDir, policy.entryModule],
        cwd: policy.directory,
        env: environment(policy),
        clearEnv: true,
        stdin: "null",
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!output.success) throw new Error(decoder.decode(output.stderr).trim() || `agent check exited ${output.code}`);
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  });
}

export function runAgent(options: {
  policy: Policy;
  policies: Readonly<Record<string, Policy>>;
  context: InvocationContext;
  input: string;
  override: Readonly<Record<string, unknown>>;
  discord?: DiscordGrant;
}) {
  return Stream.unwrap(Effect.gen(function* () {
    const root = yield* makePolicyAgent(options.policy);
    const imports: Import[] = [];
    for (const [name, value] of Object.entries(options.policy.imports)) {
      const policy = options.policies[value.policy];
      imports.push({
        name,
        agent: yield* makePolicyAgent(policy),
        config: invocationConfig(policy, { ...options.context, policy: value.policy }, value.config),
      });
    }
    if (options.policy.discord) {
      if (!options.discord) return yield* Effect.fail(new Error("Discord grant is unavailable"));
      imports.push({
        name: "discord",
        agent: yield* makeAgent({
          executable: agentExecutable(),
          sourceDir: discordSourceDir(),
          entryModule: "discord",
        }),
        config: encoder.encode(options.discord.config),
      });
    }
    return root.stream(
      encoder.encode(options.input),
      invocationConfig(options.policy, options.context, options.override),
      imports,
    );
  })).pipe(Stream.provide(processLayer));
}
