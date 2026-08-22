import { dirname, fromFileUrl, join } from "@std/path";
import { type ConnectorConfig, parseConfig, type Policy, serializeConfig } from "./config.ts";
import { botInviteUrl, readSecret, saveToken, validateToken } from "./discord/credentials.ts";
import { checkAgent } from "./runtime/invoke.ts";

async function writeConfig(path: string, content: string): Promise<void> {
  const temporary = await Deno.makeTempFile({ dir: dirname(path), prefix: ".agent-connector-", suffix: ".yaml" });
  try {
    {
      using file = await Deno.open(temporary, { write: true, truncate: true });
      const bytes = new TextEncoder().encode(content);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await file.write(bytes.subarray(offset));
        if (written === 0) throw new Error("configuration write made no progress");
        offset += written;
      }
      await file.sync();
    }
    await Deno.rename(temporary, path);
  } catch (error) {
    await Deno.remove(temporary).catch(() => {});
    throw error;
  }
}

function ask(label: string, fallback = ""): string {
  const value = prompt(fallback ? `${label} [${fallback}]` : label)?.trim();
  return value || fallback;
}

function names(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function mounts(value: string): Policy["mounts"] {
  return Object.freeze(
    names(value).map((item) => {
      const separator = item.indexOf("=");
      if (separator <= 0 || separator === item.length - 1) throw new Error(`invalid mount: ${item}`);
      return Object.freeze({
        moduleName: item.slice(0, separator).trim(),
        sourcePath: item.slice(separator + 1).trim(),
      });
    }),
  );
}

function discordRegistration(): string {
  return Deno.build.standalone
    ? join(dirname(Deno.execPath()), "registrations", "discord.md")
    : fromFileUrl(new URL("../registrations/discord.md", import.meta.url));
}

function positiveInteger(label: string, fallback: string): number {
  const value = Number(ask(label, fallback));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export async function setupNewConfig(directory: string): Promise<void> {
  const canonical = await Deno.realPath(directory);
  console.log(`\nAgent Connector setup\nTarget: ${canonical}\n`);

  const token = await readSecret("Enter Discord Bot Token");
  if (!token) throw new Error("Bot token is required");
  const identity = await validateToken(token);
  console.log(`Connected as ${identity.botName} (${identity.botId})`);

  const policyName = ask("Policy name", canonical.split(/[\\/]/).pop() || "agent");
  const policy: Policy = Object.freeze({
    entry: ask("Exact package-relative entry"),
    mounts: mounts(ask("Mounts (name=path, comma-separated)", `discord=${discordRegistration()}`)),
    trustedModules: Object.freeze(names(ask("Trusted modules (comma-separated)", "discord"))),
    directory: canonical,
    luaMemory: ask("Lua memory limit", "96MiB"),
    timeout: ask("Timeout duration", "30s"),
  });
  const concurrency = positiveInteger("Maximum concurrent agents", "4");

  const users: Record<string, string> = Object.create(null);
  const channels: Record<string, string> = Object.create(null);
  const guilds: Record<string, string> = Object.create(null);
  const user = ask("Discord User ID to route (optional)");
  const channel = ask("Channel ID to route (optional)");
  const guild = ask("Guild ID to route (optional)");
  if (user) users[user] = policyName;
  if (channel) channels[channel] = policyName;
  if (guild) guilds[guild] = policyName;

  const config: ConnectorConfig = Object.freeze({
    version: 1,
    discord: Object.freeze({ application: identity.applicationId, bot: identity.botId }),
    concurrency,
    limits: Object.freeze({
      pendingRequests: 64,
      pendingPerActor: 4,
      frameBytes: 8_388_608,
      outputMessages: 64,
    }),
    policies: Object.freeze({ [policyName]: policy }),
    users: Object.freeze(users),
    channels: Object.freeze(channels),
    guilds: Object.freeze(guilds),
  });

  const serialized = serializeConfig(config);
  const checked = parseConfig(serialized);
  await checkAgent(checked.policies[policyName]);

  const configPath = join(canonical, "agent-connector.yaml");
  await writeConfig(configPath, serialized);
  const tokenPath = await saveToken(canonical, token);
  console.log(`Config written: ${configPath}`);
  console.log(`Token saved: ${tokenPath}`);
  console.log(`Bot invite URL:\n${botInviteUrl(identity.applicationId)}\n`);
}

export async function connectExistingConfig(directory: string, config: ConnectorConfig): Promise<void> {
  const canonical = await Deno.realPath(directory);
  for (const policy of Object.values(config.policies)) await checkAgent(policy);

  if (confirm("Replace the Discord Bot Token?")) {
    const token = await readSecret("Enter replacement Discord Bot Token");
    if (!token) throw new Error("Bot token is required");
    await validateToken(token, config.discord.bot, config.discord.application);
    const tokenPath = await saveToken(canonical, token);
    console.log(`Token saved: ${tokenPath}`);
  }

  console.log(`Config valid: ${join(canonical, "agent-connector.yaml")}`);
  console.log(`Bot invite URL:\n${botInviteUrl(config.discord.application)}\n`);
}
