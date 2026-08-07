import { canonicalIdentity } from "./credentials.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

export async function getSocketPath(agentDir: string): Promise<string> {
  const identity = await canonicalIdentity(agentDir);
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || ".";
  if (Deno.build.os === "windows") {
    return `\\\\.\\pipe\\agc-${identity}`;
  }
  const sockDir = join(home, ".agents", "sockets");
  await ensureDir(sockDir);
  await Deno.chmod(sockDir, 0o700);
  return join(sockDir, `${identity}.sock`);
}

export async function startIpcServer(agentDir: string, onDown: () => void): Promise<Deno.Listener | null> {
  if (Deno.build.os === "windows") return null;
  const path = await getSocketPath(agentDir);
  try {
    await Deno.remove(path);
  } catch (_e) {
    // Socket didn't exist
  }

  const listener = Deno.listen({ transport: "unix", path });
  (async () => {
    for await (const conn of listener) {
      (async () => {
        const buf = new Uint8Array(128);
        const n = await conn.read(buf);
        if (n && n > 0) {
          const command = new TextDecoder().decode(buf.subarray(0, n)).trim();
          if (command === "down") {
            await conn.write(new TextEncoder().encode("ok\n"));
            conn.close();
            onDown();
            return;
          } else if (command === "status") {
            await conn.write(new TextEncoder().encode("running\n"));
          }
        }
        conn.close();
      })();
    }
  })();
  return listener;
}

export async function stopDaemon(agentDir: string): Promise<void> {
  const path = await getSocketPath(agentDir);
  try {
    const conn = await Deno.connect({ transport: "unix", path });
    await conn.write(new TextEncoder().encode("down\n"));
    const buf = new Uint8Array(32);
    await conn.read(buf);
    conn.close();
    console.log("Stopped Agent Connector daemon.");
  } catch (error: any) {
    throw new Error(`failed to stop daemon: ${error.message}`);
  }
}

export async function probeReady(agentDir: string, maxWaitMs = 5000): Promise<boolean> {
  const path = await getSocketPath(agentDir);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const conn = await Deno.connect({ transport: "unix", path });
      conn.close();
      return true;
    } catch (_e) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

export async function configureAutostart(agentDir: string, enable: boolean): Promise<void> {
  const identity = await canonicalIdentity(agentDir);
  const canonical = await Deno.realPath(agentDir);
  const home = Deno.env.get("HOME") || "";

  if (Deno.build.os === "linux") {
    const serviceDir = join(home, ".config", "systemd", "user");
    const servicePath = join(serviceDir, `agc-${identity}.service`);
    if (!enable) {
      try {
        await new Deno.Command("systemctl", { args: ["--user", "disable", "--now", `agc-${identity}.service`] }).output();
        await Deno.remove(servicePath);
        console.log(`Disabled systemd service agc-${identity}.service`);
      } catch (_e) {
        console.log("Service was not enabled.");
      }
      return;
    }

    await ensureDir(serviceDir);
    const exe = Deno.execPath();
    const serviceContent = `[Unit]
Description=Agent Connector for ${canonical}
After=network.target

[Service]
Type=simple
ExecStart=${exe} run --directory ${canonical}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
    await Deno.writeTextFile(servicePath, serviceContent);
    await new Deno.Command("systemctl", { args: ["--user", "daemon-reload"] }).output();
    await new Deno.Command("systemctl", { args: ["--user", "enable", "--now", `agc-${identity}.service`] }).output();
    console.log(`Enabled and started systemd service agc-${identity}.service`);
  } else if (Deno.build.os === "darwin") {
    const plistDir = join(home, "Library", "LaunchAgents");
    const plistPath = join(plistDir, `com.darkhorseprojects.agc.${identity}.plist`);
    if (!enable) {
      try {
        await new Deno.Command("launchctl", { args: ["unload", plistPath] }).output();
        await Deno.remove(plistPath);
        console.log(`Unloaded LaunchAgent com.darkhorseprojects.agc.${identity}`);
      } catch (_e) {
        console.log("LaunchAgent was not enabled.");
      }
      return;
    }
    await ensureDir(plistDir);
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
    <string>--directory</string>
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
    console.log(`Loaded LaunchAgent com.darkhorseprojects.agc.${identity}`);
  }
}
