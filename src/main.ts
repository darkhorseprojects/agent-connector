import { parseConfig } from "./config.ts";
import { loadToken, saveToken, validateToken, botInviteUrl } from "./credentials.ts";
import { checkAgent } from "./invoke.ts";
import { DiscordConnector } from "./discord.ts";
import { startIpcServer, stopDaemon, probeReady, addAutostart, removeAutostart, listAutostart } from "./lifecycle.ts";
import { setupNewConfig, editExistingConfig } from "./setup.ts";
import { join, resolve } from "@std/path";

async function loadConfig(dir: string) {
  const file = join(dir, "agent-connector.yaml");
  return parseConfig(await Deno.readTextFile(file), dir);
}

async function resolveDir(arg?: string): Promise<string> {
  if (!arg || arg === ".") return Deno.cwd();
  const direct = resolve(Deno.cwd(), arg);
  try {
    return await Deno.realPath(direct);
  } catch (_e) {}
  const home = Deno.env.get("HOME") || "";
  if (home) {
    try {
      return await Deno.realPath(resolve(home, arg));
    } catch (_e) {}
  }
  return direct;
}

async function startForegroundService(dir: string) {
  const config = await loadConfig(dir);
  const token = await loadToken(dir);

  const controller = new AbortController();
  const shutdown = () => controller.abort();
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  const connector = new DiscordConnector({
    token, config, signal: controller.signal,
    onReady: (u) => console.log(`Agent Connector ready! Connected as ${u}`),
  });

  const ipc = await startIpcServer(dir, shutdown);
  await connector.start();
  await new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => {
      connector.stop();
      ipc?.close();
      resolve();
    });
  });
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async connect(args) {
    const dir = await resolveDir(args[0]);
    try {
      await editExistingConfig(dir, await loadConfig(dir));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) await setupNewConfig(dir);
      else throw e;
    }
  },

  async check(args) {
    const dir = await resolveDir(args[0]);
    const config = await loadConfig(dir);
    console.log(`Validating ${Object.keys(config.policies).length} policies...`);
    for (const [name, policy] of Object.entries(config.policies)) {
      await checkAgent(policy);
      console.log(`  ✓ Policy '${name}' (${policy.entry}) is valid.`);
    }
    console.log("Configuration and all agent entries are ready.");
  },

  async up(args) {
    const isForeground = args.includes("--foreground") || args.includes("-f");
    const targetArg = args.find((a) => !a.startsWith("-"));
    const dir = await resolveDir(targetArg);

    await loadConfig(dir);
    await loadToken(dir);

    if (isForeground) {
      await startForegroundService(dir);
      return;
    }

    const isCompiled = !Deno.execPath().match(/deno(\.exe)?$/i);
    const spawnArgs = isCompiled
      ? ["up", "--foreground", dir]
      : ["run", "--allow-all", import.meta.url, "up", "--foreground", dir];

    const child = new Deno.Command(Deno.execPath(), {
      args: spawnArgs,
      stdout: "null", stderr: "null", stdin: "null",
    }).spawn();
    child.unref();

    if (!await probeReady(dir, 6000)) {
      console.error("Agent Connector started but IPC ready probe timed out.");
      Deno.exit(1);
    }
    console.log("Agent Connector started in background.");
  },

  async down(args) {
    const targetArg = args.find((a) => !a.startsWith("-"));
    await stopDaemon(await resolveDir(targetArg));
  },

  async auto(args) {
    const sub = args[0] || "list";
    const targetArg = args[1];
    const dir = await resolveDir(targetArg);
    if (sub === "add") await addAutostart(dir);
    else if (["remove", "rm", "delete"].includes(sub)) await removeAutostart(dir);
    else if (["list", "ls"].includes(sub)) await listAutostart();
    else {
      console.error("Usage:\n  agc auto add [DIR]\n  agc auto remove [DIR]\n  agc auto list");
      Deno.exit(1);
    }
  },
};

async function main() {
  const [cmd, ...rest] = Deno.args;
  if (!cmd || ["help", "--help", "-h"].includes(cmd)) {
    console.log(`Agent Connector (TypeScript / Portable Agents)

Usage:
  agc connect [DIR]       Interactive guided setup or configuration editor
  agc check [DIR]         Validate configuration and compile agent entry points
  agc up [DIR]            Start background connector service (or pass -f for foreground)
  agc down [DIR]          Stop running background connector service
  agc auto add [DIR]      Register and enable system autostart service (systemd / launchd)
  agc auto remove [DIR]   Unregister and remove system autostart service
  agc auto list           List all registered autostart agents and their statuses
`);
    return;
  }

  const handler = commands[cmd];
  if (handler) {
    await handler(rest);
  } else {
    // Treat unknown first argument as package directory check
    const dir = await resolveDir(cmd);
    const config = await loadConfig(dir);
    for (const policy of Object.values(config.policies)) await checkAgent(policy);
    console.log(`Agent Connector verified for ${dir}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    Deno.exit(1);
  });
}
