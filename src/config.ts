import { isAbsolute, resolve } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { Schema } from "effect";

const snowflake = /^\d{17,20}$/;
const moduleName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/));
const Positive = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Routes = Schema.Record(Schema.String, Text);
const LimitSource = Schema.Struct({
  pending_requests: Schema.optional(Positive),
  lifetime_ms: Schema.optional(Positive),
  rpc_bytes: Schema.optional(Positive),
  output_messages: Schema.optional(Positive),
});
const ImportSource = Schema.Struct({
  policy: Text,
  config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const PolicySource = Schema.Struct({
  directory: Schema.optional(Text),
  source: Text,
  entry: Text,
  memory_bytes: Positive,
  instructions: Schema.optional(Positive),
  discord: Schema.optional(Schema.Boolean),
  images: Schema.optional(Schema.Boolean),
  imports: Schema.optional(Schema.Record(Schema.String, ImportSource)),
  overrides: Schema.optional(Schema.Array(Text)),
  config: Schema.Record(Schema.String, Schema.Unknown),
});
const Root = Schema.Struct({
  version: Schema.Literal(1),
  concurrency: Schema.optional(Positive),
  profiling: Schema.optional(Schema.Boolean),
  limits: Schema.optional(LimitSource),
  policies: Schema.Record(Schema.String, Schema.Unknown),
  members: Routes,
  channels: Routes,
  guilds: Routes,
});
const decodeRoot = Schema.decodeUnknownSync(Root, { onExcessProperty: "error" });
const decodePolicy = Schema.decodeUnknownSync(PolicySource, { onExcessProperty: "error" });

export type Policy = ReturnType<typeof parsePolicy>;
export type Limits = ReturnType<typeof parseConfig>["limits"];
export type ConnectorConfig =
  & ReturnType<typeof parseConfig>
  & Readonly<{
    identity: { application: string; bot: string };
  }>;
export type InvocationContext = Readonly<{
  application: string;
  policy: string;
  member: string;
  channel: string;
  guild?: string;
  message: string;
}>;

export function parseConfig(source: string, directory: string, allowEmpty = false) {
  const root = decodeRoot(parseYaml(source));
  const policies: Record<string, Policy> = Object.create(null);
  for (const [name, value] of Object.entries(root.policies)) {
    if (!name || ["__proto__", "constructor", "prototype"].includes(name)) throw new TypeError("invalid policy name");
    policies[name] = parsePolicy(name, value, directory);
  }
  if (!allowEmpty && !Object.keys(policies).length) throw new TypeError("at least one policy must be defined");
  for (const [name, policy] of Object.entries(policies)) {
    for (const [importName, imported] of Object.entries(policy.imports)) {
      if (!importName || importName === "pa" || importName.includes("\0")) {
        throw new TypeError(`policy '${name}' import name is invalid`);
      }
      if (!Object.hasOwn(policies, imported.policy)) {
        throw new TypeError(`policy '${name}' imports unknown policy: ${imported.policy}`);
      }
      const target = policies[imported.policy];
      if (target === policy) throw new TypeError(`policy '${name}' cannot import itself`);
      if (target.discord || Object.keys(target.imports).length) {
        throw new TypeError(`policy '${name}' import '${importName}' is not a leaf policy`);
      }
    }
    if (policy.discord && Object.hasOwn(policy.imports, "discord")) {
      throw new TypeError(`policy '${name}' declares the reserved discord import`);
    }
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
    concurrency: root.concurrency ?? 4,
    profiling: root.profiling ?? false,
    limits: {
      pendingRequests: root.limits?.pending_requests ?? 32,
      lifetimeMs: root.limits?.lifetime_ms ?? 600000,
      rpcBytes: root.limits?.rpc_bytes ?? 8388608,
      outputMessages: root.limits?.output_messages ?? 32,
    },
    policies,
    members: route(root.members, "members"),
    channels: route(root.channels, "channels"),
    guilds: route(root.guilds, "guilds"),
  };
}

export function emptyConfig(): string {
  return stringifyYaml({ version: 1, policies: {}, members: {}, channels: {}, guilds: {} });
}

export function parseOverride(source: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  const value = parseYaml(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("config override must be an object");
  }
  const override = jsonObject(value, "config override");
  for (const key of Object.keys(override)) {
    if (!allowed.has(key)) throw new TypeError(`config field '${key}' cannot be overridden`);
  }
  return override;
}

export function invocationConfig(
  policy: Policy,
  context: InvocationContext,
  override: Readonly<Record<string, unknown>> = {},
): Uint8Array {
  const values: Record<string, string> = {
    application: context.application,
    policy: context.policy,
    member: context.member,
    channel: context.channel,
    guild: context.guild ?? "",
    message: context.message,
  };
  const expand = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
        if (!Object.hasOwn(values, name)) throw new TypeError(`unknown config variable: ${name}`);
        return values[name];
      });
    }
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    }
    return value;
  };
  return new TextEncoder().encode(JSON.stringify(expand(merge(policy.config, override))));
}

function parsePolicy(name: string, value: unknown, directory: string) {
  const input = decodePolicy(value);
  if (!moduleName.test(input.entry) || input.entry === "pa") throw new TypeError(`policy '${name}' entry is invalid`);
  const source = relativePath(input.source, `policy '${name}' source`);
  const imports: Record<string, { policy: string; config: Record<string, unknown> }> = Object.create(null);
  for (const [importName, imported] of Object.entries(input.imports ?? {})) {
    imports[importName] = {
      policy: imported.policy,
      config: jsonObject(imported.config ?? {}, `policy '${name}' import '${importName}' config`),
    };
  }
  const root = input.directory === undefined
    ? directory
    : isAbsolute(input.directory)
    ? input.directory
    : resolve(directory, input.directory);
  return {
    directory: root,
    sourceDir: resolve(root, source),
    entryModule: input.entry,
    memoryBytes: input.memory_bytes,
    instructions: input.instructions === undefined ? undefined : BigInt(input.instructions),
    discord: input.discord ?? false,
    images: input.images ?? false,
    imports,
    overrides: new Set(input.overrides ?? []),
    config: jsonObject(input.config, `policy '${name}' config`),
  };
}

function merge(base: unknown, overlay: unknown): unknown {
  if (
    base && overlay && typeof base === "object" && typeof overlay === "object" && !Array.isArray(base) &&
    !Array.isArray(overlay)
  ) {
    const output: Record<string, unknown> = Object.assign(Object.create(null), base);
    for (const [key, value] of Object.entries(overlay)) output[key] = merge(output[key], value);
    return output;
  }
  return overlay;
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
  try {
    const encoded = JSON.stringify(value);
    const decoded: unknown = JSON.parse(encoded);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError();
    return decoded as Record<string, unknown>;
  } catch {
    throw new TypeError(`${name} must be a JSON object`);
  }
}

function relativePath(path: string, name: string): string {
  if (
    isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new TypeError(`${name} must be a safe relative path`);
  return path;
}
