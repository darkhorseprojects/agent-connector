import { ensureDir } from "@std/fs";
import { dirname, isAbsolute, join } from "@std/path";
import { OAuth2Scopes, PermissionFlagsBits } from "discord.js";

const PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
].reduce((permissions, flag) => permissions | flag, 0n).toString();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function canonicalIdentity(directory: string): Promise<string> {
  const canonical = await Deno.realPath(directory);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getCredentialPath(directory: string): Promise<string> {
  const identity = await canonicalIdentity(directory);
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) throw new Error("home directory is unavailable");

  let base: string;
  if (Deno.build.os === "windows") {
    base = join(Deno.env.get("APPDATA") ?? home, "Agent Connector", "credentials");
  } else if (Deno.build.os === "darwin") {
    base = join(home, "Library", "Application Support", "Agent Connector", "credentials");
  } else {
    const configured = Deno.env.get("XDG_CONFIG_HOME");
    const root = configured && isAbsolute(configured) ? configured : join(home, ".config");
    base = join(root, "agent-connector", "credentials");
  }

  await ensureDir(base);
  if (Deno.build.os !== "windows") await Deno.chmod(base, 0o700);
  return join(base, `${identity}.discord-token`);
}

export async function loadToken(directory: string): Promise<string> {
  const path = await getCredentialPath(directory);
  try {
    const token = (await Deno.readTextFile(path)).trim();
    if (!token) throw new Error("token file is empty");
    return token;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`no token configured for ${directory}; run 'agc connect' first`);
    }
    throw error;
  }
}

export async function saveToken(directory: string, token: string): Promise<string> {
  token = token.trim();
  if (!token) throw new Error("token cannot be empty");
  const path = await getCredentialPath(directory);
  const temporary = await Deno.makeTempFile({ dir: dirname(path), prefix: ".discord-token-" });
  try {
    {
      using file = await Deno.open(temporary, { write: true, truncate: true, mode: 0o600 });
      const bytes = encoder.encode(token);
      let written = 0;
      while (written < bytes.length) {
        const count = await file.write(bytes.subarray(written));
        if (count === 0) throw new Error("token write made no progress");
        written += count;
      }
      await file.sync();
    }
    if (Deno.build.os !== "windows") await Deno.chmod(temporary, 0o600);
    await Deno.rename(temporary, path);
  } catch (error) {
    await Deno.remove(temporary).catch(() => {});
    throw error;
  }
  return path;
}

export async function readSecret(label: string): Promise<string> {
  if (!Deno.stdin.isTerminal()) throw new Error("secret input requires a terminal");
  await Deno.stdout.write(encoder.encode(`${label}: `));
  const windows = Deno.build.os === "windows";
  const script = windows
    ? `$s=Read-Host;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}`
    : `stty -echo; trap 'stty echo' EXIT; IFS= read -r secret; printf '\n%s' "$secret"`;
  const result = await new Deno.Command(windows ? "powershell" : "sh", {
    args: windows ? ["-NoProfile", "-Command", script] : ["-c", script],
    stdin: "inherit",
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("could not read secret input");
  return decoder.decode(result.stdout).trim();
}

export async function validateToken(
  token: string,
  expectedBotId?: string,
  expectedApplicationId?: string,
): Promise<{ botId: string; applicationId: string; botName: string }> {
  const headers = {
    Authorization: `Bot ${token}`,
    "User-Agent": "AgentConnector/1",
  };
  const request = async (path: string) => {
    const response = await fetch(`https://discord.com/api/v10/${path}`, { headers });
    if (!response.ok) throw new Error(`Discord ${path} failed: HTTP ${response.status}`);
    return await response.json();
  };
  const user = await request("users/@me");
  const application = await request("oauth2/applications/@me");

  if (expectedBotId && user.id !== expectedBotId) {
    throw new Error(`token belongs to bot ${user.id}, but configuration expects ${expectedBotId}`);
  }
  if (expectedApplicationId && application.id !== expectedApplicationId) {
    throw new Error(
      `token belongs to application ${application.id}, but configuration expects ${expectedApplicationId}`,
    );
  }

  return {
    botId: String(user.id),
    applicationId: String(application.id),
    botName: String(user.username),
  };
}

export function botInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${
    encodeURIComponent(applicationId)
  }&permissions=${PERMISSIONS}&scope=${encodeURIComponent(OAuth2Scopes.Bot)}`;
}
