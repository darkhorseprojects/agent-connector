import { isAbsolute } from "@std/path";
import { Schema } from "effect";

const snowflake = /^\d{17,20}$/;
const moduleName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/));
const Snowflake = Text.check(Schema.isPattern(snowflake));
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const PolicySchema = Schema.Struct({
  directory: Text,
  entry: Text,
  mounts: Schema.Record(Schema.String, Text),
  luaMemory: Text,
});
const ConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  discord: Schema.Struct({ application: Snowflake, bot: Snowflake }),
  concurrency: Positive,
  limits: Schema.Struct({ pendingRequests: Positive, frameBytes: Positive, outputMessages: Positive }),
  policies: Schema.Record(Schema.String, PolicySchema),
  users: Schema.Record(Schema.String, Text),
  channels: Schema.Record(Schema.String, Text),
  guilds: Schema.Record(Schema.String, Text),
});
export type Policy = Schema.Schema.Type<typeof PolicySchema>;
export type ConnectorConfig = Schema.Schema.Type<typeof ConfigSchema>;
const decode = Schema.decodeUnknownSync(ConfigSchema, { onExcessProperty: "error" });

export function parseConfig(source: string): ConnectorConfig {
  const config = decode(JSON.parse(source));
  if (!Object.keys(config.policies).length) throw new TypeError("at least one policy must be defined");
  for (const [name, policy] of Object.entries(config.policies)) {
    if (!name || ["__proto__", "constructor", "prototype"].includes(name)) throw new TypeError("invalid policy name");
    if (!isAbsolute(policy.directory)) throw new TypeError(`policy '${name}' directory must be absolute`);
    relativeSource(policy.entry, `policy '${name}' entry`);
    for (const [module, path] of Object.entries(policy.mounts)) {
      if (!moduleName.test(module) || module === "discord" || module.startsWith("pa.")) {
        throw new TypeError(`policy '${name}' mount is invalid`);
      }
      relativeSource(path, `policy '${name}' mounts.${module}`);
    }
  }
  for (
    const [field, routes] of [["users", config.users], ["channels", config.channels], [
      "guilds",
      config.guilds,
    ]] as const
  ) {
    for (const [id, policy] of Object.entries(routes)) {
      if (!snowflake.test(id)) throw new TypeError(`${field} key must be a Discord snowflake`);
      if (!Object.hasOwn(config.policies, policy)) throw new TypeError(`${field} references unknown policy: ${policy}`);
    }
  }
  return config;
}

function relativeSource(path: string, name: string): void {
  if (
    isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(`${name} must be a safe relative path`);
  }
  if (!path.endsWith(".lua") && !path.endsWith(".md")) throw new TypeError(`${name} must end in .lua or .md`);
}
