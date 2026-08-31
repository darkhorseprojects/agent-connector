import { isAbsolute } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { Schema } from "effect";

export type Policy = Readonly<{
  directory: string;
  entry: string;
  mounts: Readonly<Record<string, string>>;
  luaMemory: string;
}>;
export type ConnectorConfig = Readonly<{
  version: 1;
  discord: Readonly<{ application: string; bot: string }>;
  concurrency: number;
  limits: Readonly<{ pendingRequests: number; frameBytes: number; outputMessages: number }>;
  policies: Readonly<Record<string, Policy>>;
  users: Readonly<Record<string, string>>;
  channels: Readonly<Record<string, string>>;
  guilds: Readonly<Record<string, string>>;
}>;

const snowflake = /^\d{17,20}$/;
const moduleName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/));
const Snowflake = Text.check(Schema.isPattern(snowflake));
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Mapping = Schema.Record(Schema.String, Schema.Unknown);
const Root = Schema.Struct({
  version: Schema.Literal(1),
  discord: Schema.Struct({ application: Snowflake, bot: Snowflake }),
  concurrency: Positive,
  limits: Schema.Struct({ pending_requests: Positive, frame_bytes: Positive, output_messages: Positive }),
  policies: Mapping,
  users: Mapping,
  channels: Mapping,
  guilds: Mapping,
});
const PolicySource = Schema.Struct({
  directory: Text,
  entry: Text,
  mounts: Mapping,
  lua_memory: Text,
});
const decodeRoot = Schema.decodeUnknownSync(Root, { onExcessProperty: "error" });
const decodePolicy = Schema.decodeUnknownSync(PolicySource, { onExcessProperty: "error" });
const decodeText = Schema.decodeUnknownSync(Text);

export function parseConfig(source: string): ConnectorConfig {
  const root = decodeRoot(parseYaml(source));
  if (!Object.keys(root.policies).length) throw new TypeError("at least one policy must be defined");
  const policies: Record<string, Policy> = Object.create(null);
  for (const [name, value] of Object.entries(root.policies)) {
    safeKey(name, "policy");
    const input = decodePolicy(value);
    if (!isAbsolute(input.directory)) throw new TypeError(`policy '${name}' directory must be absolute`);
    const mounts: Record<string, string> = Object.create(null);
    for (const [module, path] of Object.entries(input.mounts)) {
      if (!moduleName.test(module) || module === "discord") throw new TypeError(`policy '${name}' mount is invalid`);
      mounts[module] = sourcePath(path, `policy '${name}' mounts.${module}`, true);
    }
    policies[name] = Object.freeze({
      directory: input.directory,
      entry: sourcePath(input.entry, `policy '${name}' entry`, false),
      mounts: Object.freeze(mounts),
      luaMemory: input.lua_memory,
    });
  }
  const routes = (input: Record<string, unknown>, field: string) =>
    Object.freeze(Object.fromEntries(
      Object.entries(input).map(([id, value]) => {
        if (!snowflake.test(id)) throw new TypeError(`${field} key must be a Discord snowflake`);
        const policy = decodeText(value);
        if (!Object.hasOwn(policies, policy)) throw new TypeError(`${field} references unknown policy: ${policy}`);
        return [id, policy];
      }),
    ));
  return Object.freeze({
    version: 1,
    discord: Object.freeze(root.discord),
    concurrency: root.concurrency,
    limits: Object.freeze({
      pendingRequests: root.limits.pending_requests,
      frameBytes: root.limits.frame_bytes,
      outputMessages: root.limits.output_messages,
    }),
    policies: Object.freeze(policies),
    users: routes(root.users, "users"),
    channels: routes(root.channels, "channels"),
    guilds: routes(root.guilds, "guilds"),
  });
}

function sourcePath(value: unknown, name: string, absolute: boolean): string {
  const path = decodeText(value);
  if (
    isAbsolute(path)
      ? !absolute
      : path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(`${name} is not an allowed source path`);
  }
  if (!path.endsWith(".lua") && !path.endsWith(".md")) throw new TypeError(`${name} must end in .lua or .md`);
  return path;
}
function safeKey(value: string, name: string): void {
  if (!value || value === "__proto__" || value === "constructor" || value === "prototype") {
    throw new TypeError(`invalid ${name} name`);
  }
}
