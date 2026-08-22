import { s } from "@sapphire/shapeshift";
import { isAbsolute } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

export type Policy = Readonly<{
  entry: string;
  mounts: readonly Readonly<{ moduleName: string; sourcePath: string }>[];
  trustedModules: readonly string[];
  directory: string;
  luaMemory: string;
  timeout: string;
}>;

export type ConnectorLimits = Readonly<{
  pendingRequests: number;
  pendingPerActor: number;
  frameBytes: number;
  outputMessages: number;
}>;

export type ConnectorConfig = Readonly<{
  version: 1;
  discord: Readonly<{ application: string; bot: string }>;
  concurrency: number;
  limits: ConnectorLimits;
  policies: Readonly<Record<string, Policy>>;
  users: Readonly<Record<string, string>>;
  channels: Readonly<Record<string, string>>;
  guilds: Readonly<Record<string, string>>;
}>;

const SNOWFLAKE = /^\d{17,20}$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const text = s.string().lengthGreaterThan(0).regex(/^[^\0]+$/);
const positiveInteger = s.number().safeInt().greaterThan(0);
const mapping = s.record(s.unknown());
const rootSchema = s.object({
  version: s.literal(1),
  discord: s.object({ application: text.regex(SNOWFLAKE), bot: text.regex(SNOWFLAKE) }).strict(),
  concurrency: positiveInteger,
  limits: s.object({
    pending_requests: positiveInteger,
    pending_per_actor: positiveInteger,
    frame_bytes: positiveInteger,
    output_messages: positiveInteger,
  }).strict(),
  policies: mapping,
  users: mapping,
  channels: mapping,
  guilds: mapping,
}).strict();
const policySchema = s.object({
  entry: text,
  mounts: mapping,
  trusted_modules: text.array(),
  directory: text,
  lua_memory: text,
  timeout: text,
}).strict();

export function parseConfig(source: string): ConnectorConfig {
  const root = rootSchema.parse(parseYaml(source));
  const limits = Object.freeze({
    pendingRequests: root.limits.pending_requests,
    pendingPerActor: root.limits.pending_per_actor,
    frameBytes: root.limits.frame_bytes,
    outputMessages: root.limits.output_messages,
  });
  if (limits.pendingPerActor > limits.pendingRequests) {
    throw new TypeError("limits.pending_per_actor cannot exceed limits.pending_requests");
  }
  if (!Object.keys(root.policies).length) throw new TypeError("at least one policy must be defined");
  const policies: Record<string, Policy> = Object.create(null);
  for (const [name, value] of Object.entries(root.policies)) {
    safeKey(name, "policy");
    const policy = policySchema.parse(value);
    if (!isAbsolute(policy.directory)) {
      throw new TypeError(`policy '${name}' directory must be absolute: ${policy.directory}`);
    }
    const mounts = Object.entries(policy.mounts).map(([moduleName, path]) => {
      if (!MODULE.test(moduleName)) throw new TypeError(`policy '${name}' mount must be a dotted Lua identifier`);
      return Object.freeze({
        moduleName,
        sourcePath: sourcePath(path, `policy '${name}' mounts.${moduleName}`, true),
      });
    });
    const trustedModules = policy.trusted_modules.map((module) => {
      if (!MODULE.test(module)) throw new TypeError(`policy '${name}' trust must be a dotted Lua identifier`);
      return module;
    });
    policies[name] = Object.freeze({
      entry: sourcePath(policy.entry, `policy '${name}' entry`, false),
      mounts: Object.freeze(mounts),
      trustedModules: Object.freeze(trustedModules),
      directory: policy.directory,
      luaMemory: policy.lua_memory,
      timeout: policy.timeout,
    });
  }

  const routes = (values: Record<string, unknown>, name: string): Readonly<Record<string, string>> => {
    const result: Record<string, string> = Object.create(null);
    for (const [id, value] of Object.entries(values)) {
      if (!SNOWFLAKE.test(id)) throw new TypeError(`${name} key must be a Discord snowflake`);
      const policy = text.parse(value);
      if (!Object.hasOwn(policies, policy)) throw new TypeError(`${name} references unknown policy: ${policy}`);
      result[id] = policy;
    }
    return Object.freeze(result);
  };

  return Object.freeze({
    version: 1,
    discord: Object.freeze(root.discord),
    concurrency: root.concurrency,
    limits,
    policies: Object.freeze(policies),
    users: routes(root.users, "users"),
    channels: routes(root.channels, "channels"),
    guilds: routes(root.guilds, "guilds"),
  });
}

export function serializeConfig(config: ConnectorConfig): string {
  const policies: Record<string, unknown> = Object.create(null);
  for (const [name, policy] of Object.entries(config.policies)) {
    policies[name] = {
      entry: policy.entry,
      mounts: Object.fromEntries(policy.mounts.map((mount) => [mount.moduleName, mount.sourcePath])),
      trusted_modules: [...policy.trustedModules],
      directory: policy.directory,
      lua_memory: policy.luaMemory,
      timeout: policy.timeout,
    };
  }
  return stringifyYaml({
    version: 1,
    discord: config.discord,
    concurrency: config.concurrency,
    limits: {
      pending_requests: config.limits.pendingRequests,
      pending_per_actor: config.limits.pendingPerActor,
      frame_bytes: config.limits.frameBytes,
      output_messages: config.limits.outputMessages,
    },
    policies,
    users: { ...config.users },
    channels: { ...config.channels },
    guilds: { ...config.guilds },
  });
}

function sourcePath(value: unknown, name: string, absolute: boolean): string {
  const path = text.parse(value);
  if (isAbsolute(path)) {
    if (!absolute) throw new TypeError(`${name} must be package-relative`);
  } else if (path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(`${name} must be an exact package path`);
  }
  if (!path.endsWith(".lua") && !path.endsWith(".md")) throw new TypeError(`${name} must end in .lua or .md`);
  return path;
}

function safeKey(value: string, name: string): void {
  if (!value || value === "__proto__" || value === "constructor" || value === "prototype") {
    throw new TypeError(`invalid ${name} name: ${value}`);
  }
}
