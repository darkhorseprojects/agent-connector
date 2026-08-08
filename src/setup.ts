import { join } from "@std/path";
import { type ConnectorConfig, type Policy, parseMemory, parseTimeout, serializeConfig } from "./config.ts";
import { saveToken, validateToken, botInviteUrl } from "./credentials.ts";

export async function ask(prompt: string, fallback = ""): Promise<string> {
  const display = fallback ? `${prompt} [${fallback}]: ` : `${prompt}: `;
  Deno.stdout.writeSync(new TextEncoder().encode(display));
  const buf = new Uint8Array(512);
  const n = await Deno.stdin.read(buf);
  const val = n ? new TextDecoder().decode(buf.subarray(0, n)).trim() : "";
  return val || fallback;
}

export async function secret(prompt: string): Promise<string> {
  Deno.stdout.writeSync(new TextEncoder().encode(`${prompt}: `));
  const buf = new Uint8Array(512);
  const n = await Deno.stdin.read(buf);
  return n ? new TextDecoder().decode(buf.subarray(0, n)).trim() : "";
}

export async function choose(title: string, options: string[], def = 0): Promise<number> {
  console.log(`\n${title}`);
  options.forEach((opt, i) => console.log(`  [${i + 1}]${i === def ? "*" : " "} ${opt}`));
  while (true) {
    const input = Number(await ask("Select option", String(def + 1)));
    if (Number.isSafeInteger(input) && input >= 1 && input <= options.length) {
      return input - 1;
    }
    console.log(`Please enter 1..${options.length}`);
  }
}

export async function discoverFiles(dir: string, ext: string): Promise<string[]> {
  const list: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(ext)) list.push(e.name);
      else if (e.isDirectory && e.name === "src") {
        for await (const s of Deno.readDir(join(dir, "src"))) {
          if (s.isFile && s.name.endsWith(ext)) list.push(join("src", s.name));
        }
      }
    }
  } catch (_e) {}
  return list.sort();
}

export async function selectPolicy(policies: Record<string, Policy>, title = "Select target policy"): Promise<string> {
  const names = Object.keys(policies);
  if (names.length <= 1) return names[0] || "zinc";
  const idx = await choose(title, names.map((n) => `${n} (entry: ${policies[n].entry})`), 0);
  return names[idx];
}

async function promptPolicy(dir: string, existing?: Policy): Promise<Policy> {
  const mdFiles = await discoverFiles(dir, ".md");
  const luaFiles = await discoverFiles(dir, ".lua");
  const defaultEntry = existing?.entry || mdFiles[0] || "agent.md";
  const entry = mdFiles.length > 1
    ? mdFiles[await choose("Select entry Markdown file", mdFiles, 0)]
    : await ask("Entry Markdown file", defaultEntry);

  const defaultAuth = existing?.authority.join(", ") || (luaFiles.length ? luaFiles.join(", ") : "src/store.lua, src/env.lua");
  const authInput = await ask("Authority modules (comma-separated)", defaultAuth);
  const authority = authInput.split(",").map((s) => s.trim()).filter(Boolean);
  const memory = await ask("Memory limit", "96MiB");
  const timeout = await ask("Timeout duration", "30s");

  return {
    entry,
    authority: Object.freeze(authority),
    directory: dir,
    memoryBytes: parseMemory(memory),
    timeoutMs: parseTimeout(timeout),
  };
}

export async function setupNewConfig(dir: string): Promise<void> {
  const canonical = await Deno.realPath(dir);
  console.log(`\n=== Agent Connector Guided Setup ===\nTarget: ${canonical}\n`);

  const token = await secret("Enter Discord Bot Token");
  if (!token) throw new Error("Bot token is required.");

  console.log("Validating with Discord API...");
  const headers = { Authorization: `Bot ${token}`, "User-Agent": "AgentConnector/0.2" };
  const user = await (await fetch("https://discord.com/api/v10/users/@me", { headers })).json();
  const app = await (await fetch("https://discord.com/api/v10/oauth2/applications/@me", { headers })).json();
  const botName = `${user.username}#${user.discriminator === "0" ? "" : user.discriminator}`;
  console.log(`✓ Connected as ${botName} (Bot ID: ${user.id}, App ID: ${app.id})\n`);

  const defaultName = canonical.split(/[\/\\]/).pop() || "zinc";
  const policyName = await ask("Policy name", defaultName);
  const policy = await promptPolicy(canonical);

  console.log("\n--- Configure Routing ---");
  const userDm = await ask("Your Discord User ID (routes DMs, or skip)", "");
  const guildId = await ask("Guild/Server ID (optional, or skip)", "");
  const channelId = await ask("Channel ID (optional, or skip)", "");

  const users: Record<string, string> = userDm ? { [userDm]: policyName } : {};
  const guilds: Record<string, string> = guildId ? { [guildId]: policyName } : {};
  const channels: Record<string, string> = channelId ? { [channelId]: policyName } : {};

  const config: ConnectorConfig = Object.freeze({
    version: 1,
    discord: Object.freeze({ application: String(app.id), bot: String(user.id) }),
    policies: Object.freeze({ [policyName]: policy }),
    users: Object.freeze(users),
    channels: Object.freeze(channels),
    guilds: Object.freeze(guilds),
  });

  const cfgPath = join(canonical, "agent-connector.yaml");
  await Deno.writeTextFile(cfgPath, serializeConfig(config));
  const tokenPath = await saveToken(canonical, token);
  console.log(`\n✓ Config written: ${cfgPath}\n✓ Token saved: ${tokenPath}`);
  console.log(`\nBot Invite URL:\n${botInviteUrl(String(app.id))}\n`);
}

export async function editExistingConfig(dir: string, config: ConnectorConfig): Promise<void> {
  const canonical = await Deno.realPath(dir);
  console.log(`\nExisting config: ${canonical} (Bot: ${config.discord.bot}, Policies: ${Object.keys(config.policies).join(", ")})`);

  const policies: Record<string, Policy> = { ...config.policies };
  const users: Record<string, string> = { ...config.users };
  const channels: Record<string, string> = { ...config.channels };
  const guilds: Record<string, string> = { ...config.guilds };
  let { application: appId, bot: botId } = config.discord;

  while (true) {
    const action = await choose("What would you like to edit?", [
      "Update Discord Bot Token",
      "Add or Edit Policy",
      "Add or Edit Routing (Users, Channels, Guilds)",
      "View Configuration & Print Invite Link",
      "Save & Exit",
      "Exit without saving",
    ], 0);

    if (action === 0) {
      const token = await secret("Enter new Bot Token");
      if (token) {
        const info = await validateToken(token, botId, appId);
        const path = await saveToken(canonical, token);
        console.log(`✓ Re-authenticated as ${info.botName}. Saved to ${path}`);
      }
    } else if (action === 1) {
      const names = Object.keys(policies);
      const sel = await choose("Choose policy to edit", [...names, "+ Create new policy"], 0);
      const name = sel < names.length ? names[sel] : await ask("New policy name");
      policies[name] = await promptPolicy(canonical, policies[name]);
      console.log(`✓ Policy '${name}' updated.`);
    } else if (action === 2) {
      const kind = await choose("Route type", ["User ID (DM)", "Guild / Server ID", "Channel ID"], 0);
      const id = await ask("Snowflake ID");
      if (id) {
        const target = await selectPolicy(policies, `Select policy for this ${kind === 0 ? "User" : kind === 1 ? "Guild" : "Channel"}`);
        if (kind === 0) users[id] = target;
        else if (kind === 1) guilds[id] = target;
        else channels[id] = target;
        console.log(`✓ Routed ${id} -> '${target}'`);
      }
    } else if (action === 3) {
      const preview: ConnectorConfig = Object.freeze({
        version: 1,
        discord: Object.freeze({ application: appId, bot: botId }),
        policies: Object.freeze(policies),
        users: Object.freeze(users),
        channels: Object.freeze(channels),
        guilds: Object.freeze(guilds),
      });
      console.log("\n" + serializeConfig(preview));
      console.log(`Bot Invite URL:\n${botInviteUrl(appId)}\n`);
    } else if (action === 4) {
      const updated: ConnectorConfig = Object.freeze({
        version: 1,
        discord: Object.freeze({ application: appId, bot: botId }),
        policies: Object.freeze(policies),
        users: Object.freeze(users),
        channels: Object.freeze(channels),
        guilds: Object.freeze(guilds),
      });
      const cfgPath = join(canonical, "agent-connector.yaml");
      await Deno.writeTextFile(cfgPath, serializeConfig(updated));
      console.log(`✓ Saved configuration to: ${cfgPath}`);
      return;
    } else {
      console.log("Exited without saving.");
      return;
    }
  }
}
