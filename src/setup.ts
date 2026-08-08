import { join, relative } from "@std/path";
import {
  type ConnectorConfig,
  type Policy,
  parseMemory,
  parseTimeout,
  serializeConfig,
} from "./config.ts";
import { saveToken, validateToken, botInviteUrl } from "./credentials.ts";

export async function promptLine(label: string, defaultValue?: string): Promise<string> {
  const display = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
  Deno.stdout.writeSync(new TextEncoder().encode(display));
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (!n) return defaultValue || "";
  const input = new TextDecoder().decode(buf.subarray(0, n)).trim();
  return input || defaultValue || "";
}

export async function promptSecret(label: string): Promise<string> {
  Deno.stdout.writeSync(new TextEncoder().encode(`${label}: `));
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (!n) return "";
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

export async function promptChoice(label: string, choices: string[], defaultIdx = 0): Promise<number> {
  console.log(`\n${label}`);
  choices.forEach((choice, idx) => {
    const marker = idx === defaultIdx ? "*" : " ";
    console.log(`  [${idx + 1}]${marker} ${choice}`);
  });
  while (true) {
    const input = await promptLine("Select an option", String(defaultIdx + 1));
    const num = Number(input);
    if (Number.isSafeInteger(num) && num >= 1 && num <= choices.length) {
      return num - 1;
    }
    console.log(`Please enter a number between 1 and ${choices.length}`);
  }
}

export async function discoverFiles(dir: string, ext: string): Promise<string[]> {
  const results: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(ext)) {
        results.push(entry.name);
      } else if (entry.isDirectory && entry.name === "src") {
        for await (const sub of Deno.readDir(join(dir, "src"))) {
          if (sub.isFile && sub.name.endsWith(ext)) {
            results.push(join("src", sub.name));
          }
        }
      }
    }
  } catch (_e) {
    // Directory might be empty or unreadable
  }
  return results.sort();
}

export async function selectPolicy(
  policies: Record<string, Policy>,
  promptTitle = "Select target policy for this route",
): Promise<string> {
  const names = Object.keys(policies);
  if (names.length === 1) return names[0];

  const choices = names.map((name) => {
    const p = policies[name];
    return `${name} (entry: ${p.entry})`;
  });

  const idx = await promptChoice(promptTitle, choices, 0);
  return names[idx];
}

export async function setupNewConfig(dir: string): Promise<void> {
  const canonicalDir = await Deno.realPath(dir);
  console.log(`\n=== Agent Connector: Guided Setup ===`);
  console.log(`Package Directory: ${canonicalDir}\n`);

  const token = await promptSecret("Enter Discord Bot Token");
  if (!token) {
    throw new Error("Bot token is required.");
  }

  console.log("Validating token with Discord API...");
  // Use temporary headers to fetch application and bot details
  const headers = {
    Authorization: `Bot ${token}`,
    "User-Agent": "AgentConnector (https://github.com/darkhorseprojects, 0.2.0)",
  };

  const userRes = await fetch("https://discord.com/api/v10/users/@me", { headers });
  if (!userRes.ok) throw new Error(`Discord authentication failed: HTTP ${userRes.status}`);
  const user = await userRes.json();
  const botId = String(user.id);
  const botName = `${user.username}#${user.discriminator === "0" ? "" : user.discriminator}`;

  const appRes = await fetch("https://discord.com/api/v10/oauth2/applications/@me", { headers });
  if (!appRes.ok) throw new Error(`Discord application lookup failed: HTTP ${appRes.status}`);
  const app = await appRes.json();
  const appId = String(app.id);

  console.log(`✓ Authenticated as: ${botName} (Bot ID: ${botId}, App ID: ${appId})\n`);

  // Discover candidate files
  const mdFiles = await discoverFiles(canonicalDir, ".md");
  const luaFiles = await discoverFiles(canonicalDir, ".lua");

  console.log("--- Define Agent Policy ---");
  const dirName = canonicalDir.split(/[\/\\]/).pop() || "agent";
  const policyName = await promptLine("Policy name", dirName);

  let entryFile = "zinc.md";
  if (mdFiles.length > 0) {
    const entryIdx = await promptChoice("Select entry Markdown file", mdFiles, 0);
    entryFile = mdFiles[entryIdx];
  } else {
    entryFile = await promptLine("Entry Markdown file", "agent.md");
  }

  const defaultAuthority = luaFiles.length > 0 ? luaFiles.join(", ") : "src/store.lua, src/env.lua";
  const authorityInput = await promptLine("Authority modules (comma-separated relative paths)", defaultAuthority);
  const authority = authorityInput
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const memoryInput = await promptLine("Memory Limit (e.g. 96MiB, 128MB)", "96MiB");
  const timeoutInput = await promptLine("Execution Timeout (e.g. 30s, 1m)", "30s");

  const policies: Record<string, Policy> = {
    [policyName]: {
      entry: entryFile,
      authority: Object.freeze(authority),
      directory: canonicalDir,
      memoryBytes: parseMemory(memoryInput),
      timeoutMs: parseTimeout(timeoutInput),
    },
  };

  console.log("\n--- Configure Message Routing ---");
  const userId = await promptLine("Your Discord User ID (routes Direct Messages to this policy, or skip)", "");
  const guildId = await promptLine("Discord Guild/Server ID (optional, or skip)", "");
  const channelId = await promptLine("Discord Channel ID (optional, or skip)", "");

  const users: Record<string, string> = {};
  const guilds: Record<string, string> = {};
  const channels: Record<string, string> = {};

  if (userId) users[userId] = policyName;
  if (guildId) guilds[guildId] = policyName;
  if (channelId) channels[channelId] = policyName;

  const config: ConnectorConfig = Object.freeze({
    version: 1,
    discord: Object.freeze({
      application: appId,
      bot: botId,
    }),
    policies: Object.freeze(policies),
    users: Object.freeze(users),
    channels: Object.freeze(channels),
    guilds: Object.freeze(guilds),
  });

  const yamlContent = serializeConfig(config);
  const configPath = join(canonicalDir, "agent-connector.yaml");
  await Deno.writeTextFile(configPath, yamlContent);
  console.log(`\n✓ Configuration written to: ${configPath}`);

  const tokenPath = await saveToken(canonicalDir, token);
  console.log(`✓ Stored credential securely at: ${tokenPath}`);

  const inviteUrl = botInviteUrl(appId);
  console.log(`\nBot Installation URL:\n${inviteUrl}\n`);
}

export async function editExistingConfig(dir: string, config: ConnectorConfig): Promise<void> {
  const canonicalDir = await Deno.realPath(dir);
  console.log(`\nExisting configuration detected for: ${canonicalDir}`);
  console.log(`Application ID: ${config.discord.application} | Bot ID: ${config.discord.bot}`);
  console.log(`Configured Policies: ${Object.keys(config.policies).join(", ")}`);

  const mutablePolicies: Record<string, Policy> = { ...config.policies };
  const mutableUsers: Record<string, string> = { ...config.users };
  const mutableChannels: Record<string, string> = { ...config.channels };
  const mutableGuilds: Record<string, string> = { ...config.guilds };
  let appId = config.discord.application;
  let botId = config.discord.bot;

  while (true) {
    const choice = await promptChoice("What would you like to edit?", [
      "Update Discord Bot Token",
      "Add or Edit Policy (entry, authority, memory, timeout)",
      "Add or Edit Routing (Users, Channels, Guilds)",
      "View Configuration & Print Invite Link",
      "Save & Exit",
      "Cancel / Exit without saving",
    ], 0);

    if (choice === 0) { // Update Bot Token
      const token = await promptSecret("Enter new Discord Bot Token");
      if (token) {
        const info = await validateToken(token, botId, appId);
        const path = await saveToken(canonicalDir, token);
        console.log(`✓ Re-authenticated as ${info.botName}. Token saved to ${path}`);
      }
    } else if (choice === 1) { // Add or Edit Policy
      const names = Object.keys(mutablePolicies);
      const policyChoice = await promptChoice(
        "Choose an action",
        [...names.map((n) => `Edit policy '${n}'`), "Create new policy"],
        0,
      );

      let targetName: string;
      let existingPolicy: Policy | undefined;

      if (policyChoice < names.length) {
        targetName = names[policyChoice];
        existingPolicy = mutablePolicies[targetName];
      } else {
        targetName = await promptLine("New policy name");
      }

      const mdFiles = await discoverFiles(canonicalDir, ".md");
      const defaultEntry = existingPolicy?.entry || (mdFiles[0] ?? "agent.md");
      const entry = await promptLine("Entry Markdown file", defaultEntry);

      const defaultAuth = existingPolicy?.authority.join(", ") || "src/store.lua, src/env.lua";
      const authInput = await promptLine("Authority modules (comma-separated relative paths)", defaultAuth);
      const authority = authInput.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

      const memoryInput = await promptLine("Memory limit", "96MiB");
      const timeoutInput = await promptLine("Execution timeout", "30s");

      mutablePolicies[targetName] = {
        entry,
        authority: Object.freeze(authority),
        directory: canonicalDir,
        memoryBytes: parseMemory(memoryInput),
        timeoutMs: parseTimeout(timeoutInput),
      };
      console.log(`✓ Policy '${targetName}' updated.`);
    } else if (choice === 2) { // Add or Edit Routing with policy selection
      const routeType = await promptChoice("Select routing kind to add or edit", [
        "User ID (Direct Messages)",
        "Guild / Server ID",
        "Channel ID",
      ], 0);

      const id = await promptLine("Enter Snowflake ID");
      if (id) {
        const selectedPolicy = await selectPolicy(
          mutablePolicies,
          `Select policy for this ${routeType === 0 ? "User" : routeType === 1 ? "Guild" : "Channel"}`,
        );

        if (routeType === 0) mutableUsers[id] = selectedPolicy;
        else if (routeType === 1) mutableGuilds[id] = selectedPolicy;
        else if (routeType === 2) mutableChannels[id] = selectedPolicy;

        console.log(`✓ Routed ${id} -> policy '${selectedPolicy}'`);
      }
    } else if (choice === 3) { // View configuration & print link
      const previewConfig: ConnectorConfig = Object.freeze({
        version: 1,
        discord: Object.freeze({ application: appId, bot: botId }),
        policies: Object.freeze(mutablePolicies),
        users: Object.freeze(mutableUsers),
        channels: Object.freeze(mutableChannels),
        guilds: Object.freeze(mutableGuilds),
      });
      console.log("\n--- Current Configuration Preview ---");
      console.log(serializeConfig(previewConfig));
      console.log(`Bot Installation URL:\n${botInviteUrl(appId)}\n`);
    } else if (choice === 4) { // Save & Exit
      const updatedConfig: ConnectorConfig = Object.freeze({
        version: 1,
        discord: Object.freeze({ application: appId, bot: botId }),
        policies: Object.freeze(mutablePolicies),
        users: Object.freeze(mutableUsers),
        channels: Object.freeze(mutableChannels),
        guilds: Object.freeze(mutableGuilds),
      });
      const yamlContent = serializeConfig(updatedConfig);
      const configPath = join(canonicalDir, "agent-connector.yaml");
      await Deno.writeTextFile(configPath, yamlContent);
      console.log(`✓ Saved configuration to: ${configPath}`);
      return;
    } else { // Cancel / Exit
      console.log("Exited without saving changes.");
      return;
    }
  }
}
