import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { canonicalIdentity } from "./credentials.ts";

export async function getSocketPath(agentDir: string): Promise<string> {
  const identity = await canonicalIdentity(agentDir);
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
  const socketDir = join(home, ".agents", "sockets");
  await ensureDir(socketDir);
  return join(socketDir, `${identity}.sock`);
}

export async function startIpcServer(agentDir: string, onStop: () => void): Promise<Deno.Listener | null> {
  if (Deno.build.os === "windows") {
    // Windows named pipes or loopback sockets
    return null;
  }
  const socketPath = await getSocketPath(agentDir);
  try {
    await Deno.remove(socketPath);
  } catch (_e) {
    // ignore if doesn't exist
  }

  const listener = Deno.listen({ path: socketPath, transport: "unix" });

  (async () => {
    for await (const conn of listener) {
      handleIpc(conn, onStop).catch(() => {});
    }
  })();

  return listener;
}

async function handleIpc(conn: Deno.Conn, onStop: () => void) {
  const buf = new Uint8Array(128);
  const n = await conn.read(buf);
  if (!n) {
    conn.close();
    return;
  }
  const msg = new TextDecoder().decode(buf.subarray(0, n)).trim();
  if (msg === "STOP") {
    await conn.write(new TextEncoder().encode("OK\n"));
    conn.close();
    onStop();
  } else if (msg === "PING") {
    await conn.write(new TextEncoder().encode("PONG\n"));
    conn.close();
  } else {
    conn.close();
  }
}

export async function stopDaemon(agentDir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    console.log("Stopping daemon on Windows is not supported via Unix sockets.");
    return;
  }
  const socketPath = await getSocketPath(agentDir);
  try {
    const conn = await Deno.connect({ path: socketPath, transport: "unix" });
    await conn.write(new TextEncoder().encode("STOP\n"));
    const buf = new Uint8Array(32);
    const n = await conn.read(buf);
    conn.close();
    if (n && new TextDecoder().decode(buf.subarray(0, n)).startsWith("OK")) {
      console.log("Agent Connector daemon stopped successfully.");
    }
  } catch (_e) {
    console.log("No running Agent Connector daemon found for this package.");
  }
}

export async function probeReady(agentDir: string, timeoutMs = 5000): Promise<boolean> {
  if (Deno.build.os === "windows") return true;
  const socketPath = await getSocketPath(agentDir);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const conn = await Deno.connect({ path: socketPath, transport: "unix" });
      await conn.write(new TextEncoder().encode("PING\n"));
      const buf = new Uint8Array(32);
      const n = await conn.read(buf);
      conn.close();
      if (n && new TextDecoder().decode(buf.subarray(0, n)).startsWith("PONG")) {
        return true;
      }
    } catch (_e) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

export async function addAutostart(agentDir: string): Promise<void> {
  const identity = await canonicalIdentity(agentDir);
  const canonical = await Deno.realPath(agentDir);
  const home = Deno.env.get("HOME") || "";

  if (Deno.build.os === "linux") {
    const serviceDir = join(home, ".config", "systemd", "user");
    await ensureDir(serviceDir);
    const servicePath = join(serviceDir, `agc-${identity}.service`);
    const exe = Deno.execPath();
    const serviceContent = `[Unit]
Description=Agent Connector for ${canonical}
After=network.target

[Service]
Type=simple
ExecStart=${exe} run ${canonical}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
    await Deno.writeTextFile(servicePath, serviceContent);
    await new Deno.Command("systemctl", { args: ["--user", "daemon-reload"] }).output();
    await new Deno.Command("systemctl", { args: ["--user", "enable", "--now", `agc-${identity}.service`] }).output();
    console.log(`✓ Added and started systemd service: agc-${identity}.service`);
  } else if (Deno.build.os === "darwin") {
    const plistDir = join(home, "Library", "LaunchAgents");
    await ensureDir(plistDir);
    const plistPath = join(plistDir, `com.darkhorseprojects.agc.${identity}.plist`);
    const exe = Deno.execPath();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.darkhorseprojects.agc.${identity}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exe}</string>
    <string>run</string>
    <string>${canonical}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;
    await Deno.writeTextFile(plistPath, plist);
    await new Deno.Command("launchctl", { args: ["load", plistPath] }).output();
    console.log(`✓ Added and loaded LaunchAgent: com.darkhorseprojects.agc.${identity}`);
  } else {
    console.log("Autostart services are supported on Linux (systemd) and macOS (launchd).");
  }
}

export async function removeAutostart(agentDir: string): Promise<void> {
  const identity = await canonicalIdentity(agentDir);
  const home = Deno.env.get("HOME") || "";

  if (Deno.build.os === "linux") {
    const serviceDir = join(home, ".config", "systemd", "user");
    const servicePath = join(serviceDir, `agc-${identity}.service`);
    try {
      await new Deno.Command("systemctl", { args: ["--user", "disable", "--now", `agc-${identity}.service`] }).output();
      await Deno.remove(servicePath);
      await new Deno.Command("systemctl", { args: ["--user", "daemon-reload"] }).output();
      console.log(`✓ Removed systemd service: agc-${identity}.service`);
    } catch (_e) {
      console.log(`Service agc-${identity}.service was not registered.`);
    }
  } else if (Deno.build.os === "darwin") {
    const plistDir = join(home, "Library", "LaunchAgents");
    const plistPath = join(plistDir, `com.darkhorseprojects.agc.${identity}.plist`);
    try {
      await new Deno.Command("launchctl", { args: ["unload", plistPath] }).output();
      await Deno.remove(plistPath);
      console.log(`✓ Removed LaunchAgent: com.darkhorseprojects.agc.${identity}`);
    } catch (_e) {
      console.log("LaunchAgent was not registered.");
    }
  }
}

export async function listAutostart(): Promise<void> {
  const home = Deno.env.get("HOME") || "";

  if (Deno.build.os === "linux") {
    const serviceDir = join(home, ".config", "systemd", "user");
    const services: Array<{ service: string; directory: string; status: string }> = [];
    try {
      for await (const entry of Deno.readDir(serviceDir)) {
        if (entry.isFile && entry.name.startsWith("agc-") && entry.name.endsWith(".service")) {
          const content = await Deno.readTextFile(join(serviceDir, entry.name));
          const match = content.match(/Description=Agent Connector for (.+)/);
          const dir = match ? match[1].trim() : "Unknown";
          let status = "unknown";
          try {
            const out = await new Deno.Command("systemctl", {
              args: ["--user", "is-active", entry.name],
            }).output();
            status = new TextDecoder().decode(out.stdout).trim() || "inactive";
          } catch (_e) {
            status = "inactive";
          }
          services.push({ service: entry.name, directory: dir, status });
        }
      }
    } catch (_e) {
      // Directory doesn't exist
    }

    if (services.length === 0) {
      console.log("No autostart agent services registered.");
      return;
    }

    console.log("REGISTERED AUTOSTART SERVICES (systemd user):");
    console.log("SERVICE".padEnd(32) + "STATUS".padEnd(16) + "PACKAGE DIRECTORY");
    console.log("-".repeat(80));
    for (const item of services) {
      console.log(item.service.padEnd(32) + item.status.padEnd(16) + item.directory);
    }
  } else if (Deno.build.os === "darwin") {
    const plistDir = join(home, "Library", "LaunchAgents");
    const agents: Array<{ label: string; directory: string }> = [];
    try {
      for await (const entry of Deno.readDir(plistDir)) {
        if (entry.isFile && entry.name.startsWith("com.darkhorseprojects.agc.") && entry.name.endsWith(".plist")) {
          const content = await Deno.readTextFile(join(plistDir, entry.name));
          const match = content.match(/<string>(.+)<\/string>\s*<\/array>/);
          const dir = match ? match[1].trim() : "Unknown";
          agents.push({ label: entry.name.replace(/\.plist$/, ""), directory: dir });
        }
      }
    } catch (_e) {
      // Directory doesn't exist
    }

    if (agents.length === 0) {
      console.log("No autostart agent services registered.");
      return;
    }

    console.log("REGISTERED AUTOSTART SERVICES (launchd):");
    console.log("LABEL".padEnd(48) + "PACKAGE DIRECTORY");
    console.log("-".repeat(80));
    for (const item of agents) {
      console.log(item.label.padEnd(48) + item.directory);
    }
  } else {
    console.log("Autostart services are supported on Linux (systemd) and macOS (launchd).");
  }
}
