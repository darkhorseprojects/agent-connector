import { isAbsolute, resolve } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { Schema } from "effect";

const snowflake = /^\d{17,20}$/;
const variable = /^[A-Za-z_][A-Za-z0-9_]*$/;
const moduleName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/));
const Snowflake = Text.check(Schema.isPattern(snowflake));
const Positive = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const TextMap = Schema.Record(Schema.String, Text);
const LimitSource = Schema.Struct({
  pending_requests: Schema.optional(Positive),
  frame_bytes: Schema.optional(Positive),
  stderr_bytes: Schema.optional(Positive),
  lifetime_ms: Schema.optional(Positive),
  rpc_bytes: Schema.optional(Positive),
  rpc_timeout_ms: Schema.optional(Positive),
  output_messages: Schema.optional(Positive),
});
const Root = Schema.Struct({
  version: Schema.Literal(1),
  discord: Schema.Struct({ application: Schema.optional(Snowflake), bot: Schema.optional(Snowflake) }),
  concurrency: Schema.optional(Positive),
  limits: Schema.optional(LimitSource),
  policies: Schema.Record(Schema.String, Schema.Unknown),
  users: TextMap,
  channels: TextMap,
  guilds: TextMap,
});
const PolicySource = Schema.Struct({
  directory: Text,
  entry: Text,
  mounts: TextMap,
  lua_memory: Text,
  environment: Schema.optional(TextMap),
  runtime: Schema.optional(Schema.Unknown),
});
const decodeRoot = Schema.decodeUnknownSync(Root, { onExcessProperty: "error" });
const decodePolicy = Schema.decodeUnknownSync(PolicySource, { onExcessProperty: "error" });

export type Policy = ReturnType<typeof policy>;
export type Limits = ReturnType<typeof parseBootstrapConfig>["limits"];
export type ConnectorConfig = ReturnType<typeof parseConfig>;

export function parseBootstrapConfig(source: string, directory: string) {
  const root = decodeRoot(parseYaml(source));
  const policies: Record<string, Policy> = Object.create(null);
  for (const [name, value] of Object.entries(root.policies)) {
    if (!name || ["__proto__", "constructor", "prototype"].includes(name)) throw new TypeError("invalid policy name");
    policies[name] = policy(name, value, directory);
  }
  const route = (input: Record<string, string>, field: string) =>
    Object.fromEntries(
      Object.entries(input).map(([id, selected]) => {
        if (!snowflake.test(id)) throw new TypeError(`${field} key must be a Discord snowflake`);
        if (!Object.hasOwn(policies, selected)) throw new TypeError(`${field} references unknown policy: ${selected}`);
        return [id, selected];
      }),
    );
  return {
    discord: root.discord,
    concurrency: root.concurrency,
    limits: {
      pendingRequests: root.limits?.pending_requests,
      frameBytes: root.limits?.frame_bytes,
      stderrBytes: root.limits?.stderr_bytes,
      lifetimeMs: root.limits?.lifetime_ms,
      rpcBytes: root.limits?.rpc_bytes,
      rpcTimeoutMs: root.limits?.rpc_timeout_ms,
      outputMessages: root.limits?.output_messages,
    },
    policies,
    users: route(root.users, "users"),
    channels: route(root.channels, "channels"),
    guilds: route(root.guilds, "guilds"),
  };
}
export function parseConfig(source: string, directory: string) {
  const config = parseBootstrapConfig(source, directory);
  if (!config.discord.application || !config.discord.bot) {
    throw new TypeError("run 'agc connect' to configure Discord identity");
  }
  if (!Object.keys(config.policies).length) throw new TypeError("at least one policy must be defined");
  return { ...config, discord: { application: config.discord.application, bot: config.discord.bot } };
}
export function configureIdentity(source: string | undefined, application: string, bot: string): string {
  const document = source === undefined
    ? { version: 1, discord: {}, policies: {}, users: {}, channels: {}, guilds: {} }
    : decodeRoot(parseYaml(source));
  return stringifyYaml({ ...document, discord: { ...document.discord, application, bot } });
}
function policy(name: string, value: unknown, directory: string) {
  const input = decodePolicy(value);
  const mounts: Record<string, string> = Object.create(null);
  for (const [module, path] of Object.entries(input.mounts)) {
    if (!moduleName.test(module) || module === "discord" || module.startsWith("pa.")) {
      throw new TypeError(`policy '${name}' mount is invalid`);
    }
    mounts[module] = sourcePath(path, `policy '${name}' mount`);
  }
  const environment: Record<string, string> = Object.create(null);
  const names = new Set<string>();
  for (const [target, source] of Object.entries(input.environment ?? {})) {
    if (
      !variable.test(target) || !variable.test(source) || /^AGENT_CONNECTOR_/i.test(target) ||
      /^AGENT_CONNECTOR_/i.test(source) || names.has(target.toLowerCase())
    ) throw new TypeError(`policy '${name}' environment mapping is invalid`);
    names.add(target.toLowerCase());
    environment[target] = source;
  }
  return {
    directory: isAbsolute(input.directory) ? input.directory : resolve(directory, input.directory),
    entry: sourcePath(input.entry, `policy '${name}' entry`),
    mounts,
    luaMemory: input.lua_memory,
    environment,
    runtime: input.runtime === undefined ? undefined : JSON.stringify(input.runtime),
  };
}
function sourcePath(path: string, name: string): string {
  if (
    isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new TypeError(`${name} must be a safe relative path`);
  if (!path.endsWith(".lua") && !path.endsWith(".md")) throw new TypeError(`${name} must end in .lua or .md`);
  return path;
}
