import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

export type Policy = Readonly<{
  entry: string;
  authority: readonly string[];
  directory: string;
  memoryBytes: number;
  timeoutMs: number;
}>;

export type ConnectorConfig = Readonly<{
  version: 1;
  discord: Readonly<{ application: string; bot: string }>;
  policies: Readonly<Record<string, Policy>>;
  users: Readonly<Record<string, string>>;
  channels: Readonly<Record<string, string>>;
  guilds: Readonly<Record<string, string>>;
}>;

const MEM_UNITS: Record<string, number> = {
  B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3,
  KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3,
};

const TIME_UNITS: Record<string, number> = {
  ms: 1, s: 1000, m: 60 * 1000, h: 3600 * 1000,
};

export function parseMemory(val: string): number {
  const m = val.trim().match(/^(\d+)\s*(B|KiB|MiB|GiB|KB|MB|GB)?$/i);
  if (!m) throw new TypeError(`invalid memory format: ${val}`);
  const amount = Number(m[1]);
  const mult = MEM_UNITS[(m[2] || "B").toUpperCase()];
  if (!Number.isSafeInteger(amount) || amount <= 0 || !mult) {
    throw new RangeError(`invalid memory value: ${val}`);
  }
  return amount * mult;
}

export function formatMemory(b: number): string {
  if (b % (1024 ** 3) === 0) return `${b / 1024 ** 3}GiB`;
  if (b % (1024 ** 2) === 0) return `${b / 1024 ** 2}MiB`;
  if (b % 1024 === 0) return `${b / 1024}KiB`;
  return `${b}B`;
}

export function parseTimeout(val: string): number {
  const m = val.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!m) throw new TypeError(`invalid timeout format: ${val}`);
  const amount = Number(m[1]);
  const mult = TIME_UNITS[(m[2] || "s").toLowerCase()];
  if (!Number.isSafeInteger(amount) || amount <= 0 || !mult) {
    throw new RangeError(`invalid timeout value: ${val}`);
  }
  return amount * mult;
}

export function formatTimeout(ms: number): string {
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function serializeConfig(config: ConnectorConfig): string {
  const policies: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(config.policies)) {
    policies[name] = {
      entry: p.entry,
      authority: [...p.authority],
      directory: p.directory,
      memory: formatMemory(p.memoryBytes),
      timeout: formatTimeout(p.timeoutMs),
    };
  }
  return stringifyYaml({
    version: 1,
    discord: { application: config.discord.application, bot: config.discord.bot },
    policies,
    users: { ...config.users },
    channels: { ...config.channels },
    guilds: { ...config.guilds },
  });
}

export function parseConfig(yamlSource: string, _packageDir?: string): ConnectorConfig {
  const raw = parseYaml(yamlSource) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("configuration root must be a YAML object");
  }

  const allowed = new Set(["version", "discord", "policies", "users", "channels", "guilds"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new TypeError(`unknown configuration key: ${k}`);
  }
  if (raw.version !== 1) throw new TypeError(`unsupported version: ${raw.version}`);

  const discord = raw.discord as Record<string, unknown>;
  if (!discord || typeof discord.application !== "string" || typeof discord.bot !== "string") {
    throw new TypeError("discord section must define application and bot IDs as strings");
  }

  const rawPolicies = (raw.policies || {}) as Record<string, Record<string, unknown>>;
  if (!rawPolicies || typeof rawPolicies !== "object" || Object.keys(rawPolicies).length === 0) {
    throw new TypeError("at least one policy must be defined");
  }

  const policies: Record<string, Policy> = {};
  for (const [name, p] of Object.entries(rawPolicies)) {
    if (!p || typeof p.entry !== "string" || typeof p.directory !== "string") {
      throw new TypeError(`policy '${name}' must define entry and directory`);
    }
    if (!p.directory.startsWith("/")) {
      throw new TypeError(`policy '${name}' directory must be an absolute path: ${p.directory}`);
    }
    const authority = Array.isArray(p.authority) ? p.authority.map(String) : [];
    policies[name] = Object.freeze({
      entry: p.entry,
      authority: Object.freeze(authority),
      directory: p.directory,
      memoryBytes: typeof p.memory === "string" ? parseMemory(p.memory) : 96 * 1024 * 1024,
      timeoutMs: typeof p.timeout === "string" ? parseTimeout(p.timeout) : 30_000,
    });
  }

  const validateRouting = (mapping: unknown, kind: string): Record<string, string> => {
    if (!mapping) return {};
    if (typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new TypeError(`${kind} must be a mapping of IDs to policy names`);
    }
    const res: Record<string, string> = {};
    for (const [id, pol] of Object.entries(mapping as Record<string, unknown>)) {
      const p = String(pol);
      if (!policies[p]) throw new TypeError(`${kind} references non-existent policy: ${p}`);
      res[String(id)] = p;
    }
    return Object.freeze(res);
  };

  return Object.freeze({
    version: 1,
    discord: Object.freeze({ application: String(discord.application), bot: String(discord.bot) }),
    policies: Object.freeze(policies),
    users: validateRouting(raw.users, "users"),
    channels: validateRouting(raw.channels, "channels"),
    guilds: validateRouting(raw.guilds, "guilds"),
  });
}
