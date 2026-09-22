import { AsyncEntry } from "@napi-rs/keyring";
import { OAuth2Scopes, PermissionFlagsBits } from "discord.js";

const SERVICE = "io.darkhorseprojects.agent-connector";
const PERMISSIONS = (
  PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.AttachFiles
).toString();
const encoder = new TextEncoder();
const snowflake = /^\d{17,20}$/;

export type DiscordCredential = Readonly<{ token: string; application: string; bot: string }>;

async function keyring(directory: string): Promise<AsyncEntry> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(await Deno.realPath(directory)));
  const account = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new AsyncEntry(
    SERVICE,
    account,
    Deno.build.os === "linux" ? { linux: { store: "secret-service" } } : undefined,
  );
}

export async function loadCredential(directory: string): Promise<DiscordCredential> {
  const source = await (await keyring(directory)).getPassword();
  if (source === undefined) throw new Error("no Discord credential; run 'agc connect' first");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Discord credential is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Discord credential is invalid");
  const credential = value as Record<string, unknown>;
  if (
    typeof credential.token !== "string" || !credential.token || credential.token.length > 8192 ||
    /\s/.test(credential.token) || typeof credential.application !== "string" ||
    !snowflake.test(credential.application) || typeof credential.bot !== "string" || !snowflake.test(credential.bot)
  ) throw new Error("Discord credential is invalid");
  return { token: credential.token, application: credential.application, bot: credential.bot };
}

export async function saveCredential(directory: string, credential: DiscordCredential): Promise<void> {
  await (await keyring(directory)).setPassword(JSON.stringify(credential));
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

export async function validateToken(token: string) {
  const headers = { Authorization: `Bot ${token}`, "User-Agent": "AgentConnector/1" };
  const request = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`https://discord.com/api/v10/${path}`, { headers });
    if (!response.ok) throw new Error(`Discord ${path} failed: HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid Discord ${path} data`);
    return value as Record<string, unknown>;
  };
  const [user, application] = await Promise.all([request("users/@me"), request("oauth2/applications/@me")]);
  const bot = typeof user.id === "string" && snowflake.test(user.id) ? user.id : "";
  const applicationId = typeof application.id === "string" && snowflake.test(application.id) ? application.id : "";
  const name = user.username;
  const botName = typeof name === "string" && name.trim() && !name.includes("\0") ? name : "";
  if (!bot || !applicationId || !botName) throw new Error("Discord identity response is invalid");
  return { bot, application: applicationId, botName };
}

export async function registerCommand(token: string, application: string): Promise<void> {
  const headers = { Authorization: `Bot ${token}`, "content-type": "application/json" };
  const route = `https://discord.com/api/v10/applications/${application}/commands`;
  const existingResponse = await fetch(route, { headers });
  if (!existingResponse.ok) throw new Error(`Discord command lookup failed: HTTP ${existingResponse.status}`);
  const existing: unknown = await existingResponse.json();
  if (!Array.isArray(existing)) throw new Error("Discord command response is invalid");
  const current = existing.find((value) =>
    value && typeof value === "object" && (value as Record<string, unknown>).name === "agent" &&
    typeof (value as Record<string, unknown>).id === "string"
  ) as Record<string, unknown> | undefined;
  const command = {
    name: "agent",
    description: "Run the configured agent policy",
    options: [
      { type: 3, name: "prompt", description: "Prompt for the agent", required: true, max_length: 6000 },
      { type: 3, name: "config", description: "One-call YAML config override", required: false, max_length: 6000 },
    ],
  };
  const response = await fetch(current ? `${route}/${current.id}` : route, {
    method: current ? "PATCH" : "POST",
    headers,
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Discord command registration failed: HTTP ${response.status}`);
}

export function botInviteUrl(application: string): string {
  const query = new URLSearchParams({
    client_id: application,
    permissions: PERMISSIONS,
    scope: `${OAuth2Scopes.Bot} ${OAuth2Scopes.ApplicationsCommands}`,
  });
  return `https://discord.com/oauth2/authorize?${query}`;
}
