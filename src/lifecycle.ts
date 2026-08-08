import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { canonicalIdentity } from "./credentials.ts";

export interface ServiceRecord {
  id: string;
  dir: string;
  status: string;
}

interface ServiceProvider {
  add(identity: string, canonical: string): Promise<void>;
  remove(identity: string): Promise<void>;
  list(): Promise<ServiceRecord[]>;
}

const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";

const systemdProvider: ServiceProvider = {
  async add(id: string, canonical: string) {
    const dir = join(home, ".config", "systemd", "user");
    await ensureDir(dir);
    const unit = `[Unit]\nDescription=Agent Connector for ${canonical}\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${Deno.execPath()} up --foreground ${canonical}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
    await Deno.writeTextFile(join(dir, `agc-${id}.service`), unit);
    await new Deno.Command("systemctl", { args: ["--user", "daemon-reload"] }).output();
    await new Deno.Command("systemctl", { args: ["--user", "enable", "--now", `agc-${id}.service`] }).output();
    console.log(`✓ Enabled and started systemd service: agc-${id}.service`);
  },

  async remove(id: string) {
    const path = join(home, ".config", "systemd", "user", `agc-${id}.service`);
    try {
      await new Deno.Command("systemctl", { args: ["--user", "disable", "--now", `agc-${id}.service`] }).output();
      await Deno.remove(path);
      await new Deno.Command("systemctl", { args: ["--user", "daemon-reload"] }).output();
      console.log(`✓ Removed systemd service: agc-${id}.service`);
    } catch (_e) {
      console.log(`Service agc-${id}.service was not registered.`);
    }
  },

  async list(): Promise<ServiceRecord[]> {
    const dir = join(home, ".config", "systemd", "user");
    const records: ServiceRecord[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.isFile && e.name.startsWith("agc-") && e.name.endsWith(".service")) {
          const content = await Deno.readTextFile(join(dir, e.name));
          const match = content.match(/Description=Agent Connector for (.+)/);
          const pkgDir = match ? match[1].trim() : "Unknown";
          let status = "inactive";
          try {
            const out = await new Deno.Command("systemctl", { args: ["--user", "is-active", e.name] }).output();
            status = new TextDecoder().decode(out.stdout).trim() || "inactive";
          } catch (_e) {}
          records.push({ id: e.name.replace(/\.service$/, ""), dir: pkgDir, status });
        }
      }
    } catch (_e) {}
    return records;
  },
};

const launchdProvider: ServiceProvider = {
  async add(id: string, canonical: string) {
    const dir = join(home, "Library", "LaunchAgents");
    await ensureDir(dir);
    const path = join(dir, `com.darkhorseprojects.agc.${id}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.darkhorseprojects.agc.${id}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${Deno.execPath()}</string>\n    <string>up</string>\n    <string>--foreground</string>\n    <string>${canonical}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n</dict>\n</plist>`;
    await Deno.writeTextFile(path, plist);
    await new Deno.Command("launchctl", { args: ["load", path] }).output();
    console.log(`✓ Loaded LaunchAgent: com.darkhorseprojects.agc.${id}`);
  },

  async remove(id: string) {
    const path = join(home, "Library", "LaunchAgents", `com.darkhorseprojects.agc.${id}.plist`);
    try {
      await new Deno.Command("launchctl", { args: ["unload", path] }).output();
      await Deno.remove(path);
      console.log(`✓ Removed LaunchAgent: com.darkhorseprojects.agc.${id}`);
    } catch (_e) {
      console.log("LaunchAgent was not registered.");
    }
  },

  async list(): Promise<ServiceRecord[]> {
    const dir = join(home, "Library", "LaunchAgents");
    const records: ServiceRecord[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.isFile && e.name.startsWith("com.darkhorseprojects.agc.") && e.name.endsWith(".plist")) {
          const content = await Deno.readTextFile(join(dir, e.name));
          const match = content.match(/<string>(.+)<\/string>\s*<\/array>/);
          records.push({ id: e.name.replace(/\.plist$/, ""), dir: match ? match[1].trim() : "Unknown", status: "loaded" });
        }
      }
    } catch (_e) {}
    return records;
  },
};

const windowsStartupProvider: ServiceProvider = {
  async add(id: string, canonical: string) {
    const appdata = Deno.env.get("APPDATA") || join(home, "AppData", "Roaming");
    const dir = join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    await ensureDir(dir);
    const cmdPath = join(dir, `agc-${id}.cmd`);
    const script = `@echo off\nstart /b "" "${Deno.execPath()}" up --foreground "${canonical}"\n`;
    await Deno.writeTextFile(cmdPath, script);
    console.log(`✓ Added Windows Startup shortcut: ${cmdPath}`);
  },

  async remove(id: string) {
    const appdata = Deno.env.get("APPDATA") || join(home, "AppData", "Roaming");
    const cmdPath = join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `agc-${id}.cmd`);
    try {
      await Deno.remove(cmdPath);
      console.log(`✓ Removed Windows Startup shortcut: agc-${id}.cmd`);
    } catch (_e) {
      console.log("Windows Startup shortcut was not registered.");
    }
  },

  async list(): Promise<ServiceRecord[]> {
    const appdata = Deno.env.get("APPDATA") || join(home, "AppData", "Roaming");
    const dir = join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    const records: ServiceRecord[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.isFile && e.name.startsWith("agc-") && e.name.endsWith(".cmd")) {
          const content = await Deno.readTextFile(join(dir, e.name));
          const match = content.match(/--foreground "(.+)"/);
          records.push({ id: e.name.replace(/\.cmd$/, ""), dir: match ? match[1].trim() : "Unknown", status: "enabled" });
        }
      }
    } catch (_e) {}
    return records;
  },
};

function getProvider(): ServiceProvider {
  if (Deno.build.os === "linux") return systemdProvider;
  if (Deno.build.os === "darwin") return launchdProvider;
  return windowsStartupProvider;
}

export async function addAutostart(agentDir: string): Promise<void> {
  const id = await canonicalIdentity(agentDir);
  const canonical = await Deno.realPath(agentDir);
  await getProvider().add(id, canonical);
}

export async function removeAutostart(agentDir: string): Promise<void> {
  const id = await canonicalIdentity(agentDir);
  await getProvider().remove(id);
}

export async function listAutostart(): Promise<void> {
  const records = await getProvider().list();
  if (records.length === 0) {
    console.log("No autostart agent services registered.");
    return;
  }
  console.log("REGISTERED AUTOSTART SERVICES:");
  console.log("SERVICE / LABEL".padEnd(40) + "STATUS".padEnd(16) + "PACKAGE DIRECTORY");
  console.log("-".repeat(80));
  for (const r of records) {
    console.log(r.id.padEnd(40) + r.status.padEnd(16) + r.dir);
  }
}

// ---------------------- Cross-Platform IPC ----------------------

type IpcAddress =
  | { transport: "unix"; path: string }
  | { transport: "tcp"; hostname: string; port: number };

export async function getSocketPath(agentDir: string): Promise<string> {
  const identity = await canonicalIdentity(agentDir);
  const socketDir = join(home, ".agents", "sockets");
  await ensureDir(socketDir);
  return join(socketDir, `${identity}.sock`);
}

function getIpcAddress(_agentDir: string, identity: string): IpcAddress {
  if (Deno.build.os === "windows") {
    const port = 30000 + (parseInt(identity.slice(0, 4), 16) % 30000);
    return { transport: "tcp", hostname: "127.0.0.1", port };
  }
  const socketDir = join(home, ".agents", "sockets");
  return { transport: "unix", path: join(socketDir, `${identity}.sock`) };
}

export async function startIpcServer(agentDir: string, onStop: () => void): Promise<Deno.Listener | null> {
  const identity = await canonicalIdentity(agentDir);
  const addr = getIpcAddress(agentDir, identity);
  let listener: Deno.Listener;

  if (addr.transport === "unix") {
    try { await Deno.remove(addr.path); } catch (_e) {}
    await ensureDir(join(home, ".agents", "sockets"));
    listener = Deno.listen({ transport: "unix", path: addr.path });
  } else {
    listener = Deno.listen({ transport: "tcp", hostname: addr.hostname, port: addr.port });
  }

  (async () => {
    for await (const conn of listener) {
      handleIpc(conn, onStop).catch(() => {});
    }
  })();
  return listener;
}

async function handleIpc(conn: Deno.Conn, onStop: () => void) {
  const buf = new Uint8Array(64);
  const n = await conn.read(buf);
  const msg = n ? new TextDecoder().decode(buf.subarray(0, n)).trim() : "";
  if (msg === "STOP") {
    try {
      await conn.write(new TextEncoder().encode("OK\n"));
    } catch (_e) {}
    conn.close();
    onStop();
    // Guarantee clean process termination after acknowledging stop command
    setTimeout(() => Deno.exit(0), 100);
  } else if (msg === "PING") {
    try {
      await conn.write(new TextEncoder().encode("PONG\n"));
    } catch (_e) {}
    conn.close();
  } else {
    conn.close();
  }
}

async function sendIpcCommand(agentDir: string, cmd: string): Promise<string | null> {
  const identity = await canonicalIdentity(agentDir);
  const addr = getIpcAddress(agentDir, identity);
  try {
    const conn = addr.transport === "unix"
      ? await Deno.connect({ transport: "unix", path: addr.path })
      : await Deno.connect({ transport: "tcp", hostname: addr.hostname, port: addr.port });
    await conn.write(new TextEncoder().encode(`${cmd}\n`));
    const buf = new Uint8Array(64);
    const n = await conn.read(buf);
    conn.close();
    return n ? new TextDecoder().decode(buf.subarray(0, n)).trim() : null;
  } catch (_e) {
    return null;
  }
}

export async function stopDaemon(agentDir: string): Promise<boolean> {
  const res = await sendIpcCommand(agentDir, "STOP");
  if (res?.startsWith("OK")) {
    return true;
  }
  return false;
}

export async function probeReady(agentDir: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await sendIpcCommand(agentDir, "PING");
    if (res?.startsWith("PONG")) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
