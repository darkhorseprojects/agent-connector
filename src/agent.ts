import * as NodeChildProcessSpawner from "@effect/platform-node/child-process";
import * as NodeFileSystem from "@effect/platform-node/file-system";
import * as NodePath from "@effect/platform-node/path";
import { type Import, make as makeAgent } from "@darkhorseprojects/portable-agents";
import { dirname, fromFileUrl, isAbsolute, join } from "@std/path";
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
  if (!Deno.build.standalone) return fromFileUrl(new URL("../packages/discord", import.meta.url));
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (Deno.build.os === "windows") {
    const data = Deno.env.get("LOCALAPPDATA");
    if (!data || !isAbsolute(data)) throw new Error("LOCALAPPDATA is unavailable");
    return join(data, "Agent Connector", "packages", "discord");
  }
  if (!home || !isAbsolute(home)) throw new Error("home directory is unavailable");
  if (Deno.build.os === "darwin") {
    return join(home, "Library", "Application Support", "Agent Connector", "packages", "discord");
  }
  const configured = Deno.env.get("XDG_DATA_HOME");
  const data = configured && isAbsolute(configured) ? configured : join(home, ".local", "share");
  return join(data, "agent-connector", "packages", "discord");
}

function environment() {
  const home = Deno.env.get(Deno.build.os === "windows" ? "USERPROFILE" : "HOME");
  const systemRoot = Deno.build.os === "windows" ? Deno.env.get("SystemRoot") : undefined;
  return {
    ...(home === undefined ? {} : { HOME: home }),
    ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }),
  };
}

function makePolicyAgent(policy: Policy) {
  return makeAgent({
    executable: agentExecutable(),
    sourceDir: policy.sourceDir,
    entryModule: policy.entryModule,
    memoryBytes: policy.memoryBytes,
    instructions: policy.instructions,
    cwd: policy.directory,
    environment: environment(),
  });
}

export function checkAgent(policy: Policy) {
  return Effect.tryPromise({
    try: async () => {
      const output = await new Deno.Command(agentExecutable(), {
        args: ["check", policy.sourceDir, policy.entryModule],
        cwd: policy.directory,
        env: environment(),
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
