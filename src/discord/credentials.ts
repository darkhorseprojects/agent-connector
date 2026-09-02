import { dirname, isAbsolute, join } from "@std/path";
import { OAuth2Scopes, PermissionFlagsBits } from "discord.js";

const PERMISSIONS = (
  PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.AttachFiles
).toString();
const encoder = new TextEncoder();
const snowflake = /^\d{17,20}$/;

async function credentialPath(directory: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(await Deno.realPath(directory)));
  const identity = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) throw new Error("home directory is unavailable");
  const configured = Deno.env.get("XDG_CONFIG_HOME");
  const base = Deno.build.os === "windows"
    ? join(Deno.env.get("APPDATA") ?? home, "Agent Connector", "credentials")
    : Deno.build.os === "darwin"
    ? join(home, "Library", "Application Support", "Agent Connector", "credentials")
    : join(configured && isAbsolute(configured) ? configured : join(home, ".config"), "agent-connector", "credentials");
  await Deno.mkdir(base, { recursive: true, mode: 0o700 });
  if (Deno.build.os !== "windows") await Deno.chmod(base, 0o700);
  return join(base, `${identity}.discord-token`);
}
export async function loadToken(directory: string): Promise<string> {
  try {
    const token = (await Deno.readTextFile(await credentialPath(directory))).trim();
    if (!token) throw new Error("token file is empty");
    return token;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) throw new Error("no token; run 'agc connect' first");
    throw error;
  }
}
export async function saveToken(directory: string, token: string): Promise<void> {
  token = token.trim();
  if (!token || token.length > 8192 || /\s/.test(token)) throw new Error("token is invalid");
  await writeAtomic(await credentialPath(directory), token, false, 0o600);
}
export async function writeAtomic(path: string, text: string, create: boolean, mode = 0o600): Promise<void> {
  const temporary = await Deno.makeTempFile({ dir: dirname(path), prefix: ".agent-connector-" });
  try {
    await Deno.writeTextFile(temporary, text, { mode });
    {
      using file = await Deno.open(temporary, { write: true });
      await file.sync();
    }
    if (Deno.build.os !== "windows") await Deno.chmod(temporary, mode);
    if (create) {
      await Deno.link(temporary, path);
      await Deno.remove(temporary);
    } else await Deno.rename(temporary, path);
  } catch (error) {
    await Deno.remove(temporary).catch(() => {});
    throw error;
  }
}
export async function readSecret(label: string): Promise<string> {
  if (!Deno.stdin.isTerminal()) throw new Error("secret input requires a terminal");
  await Deno.stdout.write(encoder.encode(`${label}: `));
  const input = new Uint8Array(1);
  const secret: number[] = [];
  Deno.stdin.setRaw(true);
  try {
    while (true) {
      if (await Deno.stdin.read(input) === null) throw new Error("secret input ended unexpectedly");
      const byte = input[0];
      if (byte === 3) throw new DOMException("secret input interrupted", "AbortError");
      if (byte === 10 || byte === 13) break;
      if (byte === 8 || byte === 127) secret.pop();
      else {
        if (byte < 33 || byte > 126 || secret.length === 8192) throw new Error("secret contains invalid input");
        secret.push(byte);
      }
    }
  } finally {
    Deno.stdin.setRaw(false);
    await Deno.stdout.write(encoder.encode("\n"));
  }
  if (!secret.length) throw new Error("token cannot be empty");
  return String.fromCharCode(...secret);
}
export async function validateToken(token: string, expectedBot?: string, expectedApplication?: string) {
  const headers = { Authorization: `Bot ${token}`, "User-Agent": "AgentConnector/1" };
  const request = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`https://discord.com/api/v10/${path}`, { headers });
    if (!response.ok) throw new Error(`Discord ${path} failed: HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid Discord ${path} data`);
    return value as Record<string, unknown>;
  };
  const [user, application] = await Promise.all([request("users/@me"), request("oauth2/applications/@me")]);
  const botId = typeof user.id === "string" && snowflake.test(user.id) ? user.id : "";
  const applicationId = typeof application.id === "string" && snowflake.test(application.id) ? application.id : "";
  const name = user.username;
  const botName = typeof name === "string" && name.trim() && !name.includes("\0") ? name : "";
  if (!botId || !applicationId || !botName) throw new Error("Discord identity response is invalid");
  if (expectedBot && botId !== expectedBot) throw new Error(`token bot ${botId} does not match ${expectedBot}`);
  if (expectedApplication && applicationId !== expectedApplication) throw new Error("token application mismatch");
  return { botId, applicationId, botName };
}
export function botInviteUrl(applicationId: string): string {
  const query = new URLSearchParams({ client_id: applicationId, permissions: PERMISSIONS, scope: OAuth2Scopes.Bot });
  return `https://discord.com/oauth2/authorize?${query}`;
}
