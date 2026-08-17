import { isAbsolute } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

export type Policy = Readonly<{
  entry: string;
  register: Readonly<Record<string, string>>;
  authorize: readonly string[];
  directory: string;
  memory: string;
  timeout: string;
}>;

export type ConnectorLimits = Readonly<{
  pendingRequests: number;
  pendingPerActor: number;
  eventBytes: number;
  outputBytes: number;
  outputMessages: number;
  rpcBytes: number;
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

export function parseConfig(source: string): ConnectorConfig {
  const root = object(parseYaml(source), "configuration root");
  exact(
    root,
    ["version", "discord", "concurrency", "limits", "policies", "users", "channels", "guilds"],
    "configuration",
  );
  if (root.version !== 1) throw new TypeError(`unsupported version: ${String(root.version)}`);

  const rawDiscord = object(root.discord, "discord");
  exact(rawDiscord, ["application", "bot"], "discord");
  const discord = Object.freeze({
    application: snowflake(rawDiscord.application, "discord.application"),
    bot: snowflake(rawDiscord.bot, "discord.bot"),
  });
  const concurrency = positiveInteger(root.concurrency, "concurrency");
  const rawLimits = object(root.limits, "limits");
  exact(
    rawLimits,
    ["pending_requests", "pending_per_actor", "event_bytes", "output_bytes", "output_messages", "rpc_bytes"],
    "limits",
  );
  const limits = Object.freeze({
    pendingRequests: positiveInteger(rawLimits.pending_requests, "limits.pending_requests"),
    pendingPerActor: positiveInteger(rawLimits.pending_per_actor, "limits.pending_per_actor"),
    eventBytes: positiveInteger(rawLimits.event_bytes, "limits.event_bytes"),
    outputBytes: positiveInteger(rawLimits.output_bytes, "limits.output_bytes"),
    outputMessages: positiveInteger(rawLimits.output_messages, "limits.output_messages"),
    rpcBytes: positiveInteger(rawLimits.rpc_bytes, "limits.rpc_bytes"),
  });
  if (limits.pendingPerActor > limits.pendingRequests) {
    throw new TypeError("limits.pending_per_actor cannot exceed limits.pending_requests");
  }
  const rawPolicies = object(root.policies, "policies");
  if (!Object.keys(rawPolicies).length) throw new TypeError("at least one policy must be defined");
  const policies: Record<string, Policy> = Object.create(null);
  for (const [name, value] of Object.entries(rawPolicies)) {
    safeKey(name, "policy");
    const policy = object(value, `policy '${name}'`);
    exact(policy, ["entry", "register", "authorize", "directory", "memory", "timeout"], `policy '${name}'`);
    const directory = text(policy.directory, `policy '${name}' directory`);
    if (!isAbsolute(directory)) throw new TypeError(`policy '${name}' directory must be absolute: ${directory}`);
    const register: Record<string, string> = Object.create(null);
    for (const [module, path] of Object.entries(object(policy.register, `policy '${name}' register`))) {
      moduleName(module, `policy '${name}' registration`);
      register[module] = sourcePath(path, `policy '${name}' register.${module}`, true);
    }
    const authorize = array(policy.authorize, `policy '${name}' authorize`).map((value, index) =>
      moduleName(value, `policy '${name}' authorize[${index}]`)
    );
    policies[name] = Object.freeze({
      entry: sourcePath(policy.entry, `policy '${name}' entry`, false),
      register: Object.freeze(register),
      authorize: Object.freeze(authorize),
      directory,
      memory: text(policy.memory, `policy '${name}' memory`),
      timeout: text(policy.timeout, `policy '${name}' timeout`),
    });
  }

  const routes = (value: unknown, name: string): Readonly<Record<string, string>> => {
    const mapping = object(value, name);
    const result: Record<string, string> = Object.create(null);
    for (const [id, target] of Object.entries(mapping)) {
      snowflake(id, `${name} key`);
      const policy = text(target, `${name}.${id}`);
      if (!Object.hasOwn(policies, policy)) throw new TypeError(`${name} references unknown policy: ${policy}`);
      result[id] = policy;
    }
    return Object.freeze(result);
  };

  return Object.freeze({
    version: 1,
    discord,
    concurrency,
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
      register: { ...policy.register },
      authorize: [...policy.authorize],
      directory: policy.directory,
      memory: policy.memory,
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
      event_bytes: config.limits.eventBytes,
      output_bytes: config.limits.outputBytes,
      output_messages: config.limits.outputMessages,
      rpc_bytes: config.limits.rpcBytes,
    },
    policies,
    users: { ...config.users },
    channels: { ...config.channels },
    guilds: { ...config.guilds },
  });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new TypeError(`unknown ${name} key: ${key}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new TypeError(`${name} must be nonempty text without NUL`);
  }
  return value;
}

function moduleName(value: unknown, name: string): string {
  const result = text(value, name);
  if (!MODULE.test(result)) throw new TypeError(`${name} must be dotted Lua identifiers`);
  return result;
}

function snowflake(value: unknown, name: string): string {
  const result = text(value, name);
  if (!SNOWFLAKE.test(result)) throw new TypeError(`${name} must be a Discord snowflake`);
  return result;
}

function sourcePath(value: unknown, name: string, absolute: boolean): string {
  const path = text(value, name);
  if (isAbsolute(path)) {
    if (!absolute) throw new TypeError(`${name} must be package-relative`);
  } else if (path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(`${name} must be an exact package path`);
  }
  if (!path.endsWith(".lua") && !path.endsWith(".md")) throw new TypeError(`${name} must end in .lua or .md`);
  return path;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value as number;
}

function safeKey(value: string, name: string): void {
  if (!value || value === "__proto__" || value === "constructor" || value === "prototype") {
    throw new TypeError(`invalid ${name} name: ${value}`);
  }
}
