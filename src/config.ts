import { parse as parseYaml } from "@std/yaml";
import { resolve } from "@std/path";

export type Policy = Readonly<{
  entry: string;
  authority: readonly string[];
  directory: string;
  memoryBytes: number;
  timeoutMs: number;
}>;

export type ConnectorConfig = Readonly<{
  version: 1;
  discord: Readonly<{
    application: string;
    bot: string;
  }>;
  policies: Readonly<Record<string, Policy>>;
  users: Readonly<Record<string, string>>;
  channels: Readonly<Record<string, string>>;
  guilds: Readonly<Record<string, string>>;
}>;

export function parseMemory(value: string): number {
  const match = value.trim().match(/^(\d+)\s*(B|KiB|MiB|GiB|KB|MB|GB)?$/i);
  if (!match) throw new TypeError(`invalid memory format: ${value}`);
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError(`invalid memory amount: ${value}`);
  const unit = (match[2] || "B").toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KIB: 1024,
    MIB: 1024 * 1024,
    GIB: 1024 * 1024 * 1024,
    KB: 1000,
    MB: 1000 * 1000,
    GB: 1000 * 1000 * 1000,
  };
  const multiplier = multipliers[unit];
  if (multiplier === undefined) throw new TypeError(`unknown memory unit: ${unit}`);
  return amount * multiplier;
}

export function parseTimeout(value: string): number {
  const match = value.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!match) throw new TypeError(`invalid timeout format: ${value}`);
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError(`invalid timeout amount: ${value}`);
  const unit = (match[2] || "s").toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 3600 * 1000,
  };
  return amount * multipliers[unit];
}

export function parseConfig(yamlSource: string, packageDir: string): ConnectorConfig {
  const raw = parseYaml(yamlSource) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("configuration root must be a YAML object");
  }

  const allowedRootKeys = new Set(["version", "discord", "policies", "users", "channels", "guilds"]);
  for (const key of Object.keys(raw)) {
    if (!allowedRootKeys.has(key)) throw new TypeError(`unknown configuration key: ${key}`);
  }

  if (raw.version !== 1) throw new TypeError(`unsupported version: ${raw.version}`);

  const discord = raw.discord as Record<string, unknown>;
  if (!discord || typeof discord !== "object" || typeof discord.application !== "string" || typeof discord.bot !== "string") {
    throw new TypeError("discord section must define application and bot IDs as strings");
  }

  const rawPolicies = (raw.policies || {}) as Record<string, Record<string, unknown>>;
  if (typeof rawPolicies !== "object" || Array.isArray(rawPolicies) || Object.keys(rawPolicies).length === 0) {
    throw new TypeError("at least one policy must be defined");
  }

  const policies: Record<string, Policy> = {};
  for (const [name, pol] of Object.entries(rawPolicies)) {
    if (!pol || typeof pol !== "object" || typeof pol.entry !== "string" || typeof pol.directory !== "string") {
      throw new TypeError(`policy '${name}' must define entry and directory`);
    }
    if (!pol.directory.startsWith("/")) {
      throw new TypeError(`policy '${name}' directory must be an absolute path: ${pol.directory}`);
    }
    const authority = Array.isArray(pol.authority)
      ? pol.authority.map((a) => String(a))
      : [];
    const memoryBytes = typeof pol.memory === "string" ? parseMemory(pol.memory) : 96 * 1024 * 1024;
    const timeoutMs = typeof pol.timeout === "string" ? parseTimeout(pol.timeout) : 30_000;

    policies[name] = Object.freeze({
      entry: pol.entry,
      authority: Object.freeze(authority),
      directory: pol.directory,
      memoryBytes,
      timeoutMs,
    });
  }

  const validateRouting = (mapping: unknown, kind: string): Record<string, string> => {
    if (!mapping) return {};
    if (typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new TypeError(`${kind} must be a mapping of IDs to policy names`);
    }
    const result: Record<string, string> = {};
    for (const [id, polName] of Object.entries(mapping as Record<string, unknown>)) {
      const p = String(polName);
      if (!policies[p]) throw new TypeError(`${kind} references non-existent policy: ${p}`);
      result[String(id)] = p;
    }
    return Object.freeze(result);
  };

  return Object.freeze({
    version: 1,
    discord: Object.freeze({
      application: String(discord.application),
      bot: String(discord.bot),
    }),
    policies: Object.freeze(policies),
    users: validateRouting(raw.users, "users"),
    channels: validateRouting(raw.channels, "channels"),
    guilds: validateRouting(raw.guilds, "guilds"),
  });
}
