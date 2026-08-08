import { crypto } from "@std/crypto";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

// Permissions: View Channels (1024) | Send Messages (2048) | Read Message History (65536)
// Embed Links (16384) | Attach Files (32768) | Add Reactions (64) | Use External Emojis (262144)
// Create Public Threads (34359738368) | Create Private Threads (68719476736) | Send Messages in Threads (274877906944)
const PERMISSIONS = "377957530432";

export async function canonicalIdentity(dirPath: string): Promise<string> {
  const canonical = await Deno.realPath(dirPath);
  const data = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getCredentialPath(dirPath: string): Promise<string> {
  const identity = await canonicalIdentity(dirPath);
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!home) throw new Error("home directory is not available");

  const isWindows = Deno.build.os === "windows";
  const baseDir = isWindows
    ? join(Deno.env.get("LOCALAPPDATA") || home, "Agent Connector", "credentials")
    : join(home, ".agents", "credentials");

  await ensureDir(baseDir);
  if (!isWindows) {
    await Deno.chmod(baseDir, 0o700);
  }
  return join(baseDir, `${identity}.discord-token`);
}

export async function loadToken(dirPath: string): Promise<string> {
  const path = await getCredentialPath(dirPath);
  try {
    const text = await Deno.readTextFile(path);
    const token = text.trim();
    if (!token) throw new Error("token file is empty");
    return token;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`no token configured for ${dirPath}. Run 'agc connect' first.`);
    }
    throw error;
  }
}

export async function saveToken(dirPath: string, token: string): Promise<string> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("token cannot be empty");
  const path = await getCredentialPath(dirPath);
  await Deno.writeTextFile(path, trimmed);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(path, 0o600);
  }
  return path;
}

export async function validateToken(
  token: string,
  expectedBotId: string,
  expectedAppId: string,
): Promise<{ botName: string }> {
  const headers = {
    Authorization: `Bot ${token}`,
    "User-Agent": "AgentConnector (https://github.com/darkhorseprojects, 0.2.0)",
  };

  const userRes = await fetch("https://discord.com/api/v10/users/@me", { headers });
  if (!userRes.ok) throw new Error(`Discord authentication failed: HTTP ${userRes.status}`);
  const user = await userRes.json();
  if (user.id !== expectedBotId) {
    throw new Error(`Token belongs to bot user ${user.id} (${user.username}), but configuration expects ${expectedBotId}`);
  }

  const appRes = await fetch("https://discord.com/api/v10/oauth2/applications/@me", { headers });
  if (!appRes.ok) throw new Error(`Discord application lookup failed: HTTP ${appRes.status}`);
  const app = await appRes.json();
  if (app.id !== expectedAppId) {
    throw new Error(`Token belongs to application ${app.id}, but configuration expects ${expectedAppId}`);
  }

  return { botName: `${user.username}#${user.discriminator === "0" ? "" : user.discriminator}` };
}

export function botInviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&permissions=${PERMISSIONS}&scope=bot%20applications.commands`;
}
