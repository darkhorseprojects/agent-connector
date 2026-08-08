import { parseConfig } from "./config.ts";
import { loadToken, saveToken, validateToken, botInviteUrl } from "./credentials.ts";
import { checkAgent } from "./invoke.ts";
import { DiscordConnector } from "./discord.ts";
import { startIpcServer, stopDaemon, probeReady, addAutostart, removeAutostart, listAutostart } from "./lifecycle.ts";
import { setupNewConfig, editExistingConfig } from "./setup.ts";
import { join } from "@std/path";

async function loadAgentConfig(dir: string) {
  const configFile = join(dir, "agent-connector.yaml");
  const yamlText = await Deno.readTextFile(configFile);
  return parseConfig(yamlText, dir);
}

function resolveDir(argDir?: string): string {
  return argDir ? argDir : Deno.cwd();
}

async function main() {
  const args = Deno.args;
  const command = args[0] || "check";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`Agent Connector (TypeScript / Portable Agents)

Usage:
  agc connect [DIR]       Interactive guided setup or configuration editor
  agc check [DIR]         Validate configuration and compile agent entry points
  agc run [DIR]           Run foreground connector service
  agc up [DIR]            Start detached background connector service
  agc down [DIR]          Stop running background connector service
  agc auto add [DIR]      Register and enable system autostart service (systemd / launchd)
  agc auto remove [DIR]   Unregister and remove system autostart service
  agc auto list           List all registered autostart agents and their statuses
`);
    return;
  }

  if (command === "connect") {
    const dir = resolveDir(args[1]);
    try {
      const config = await loadAgentConfig(dir);
      await editExistingConfig(dir, config);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        await setupNewConfig(dir);
      } else {
        throw error;
      }
    }
    return;
  }

  if (command === "check") {
    const dir = resolveDir(args[1]);
    const config = await loadAgentConfig(dir);
    console.log(`Validating ${Object.keys(config.policies).length} policies...`);
    for (const [name, policy] of Object.entries(config.policies)) {
      await checkAgent(policy);
      console.log(`  ✓ Policy '${name}' (${policy.entry}) is valid.`);
    }
    console.log("Configuration and all agent entries are ready.");
    return;
  }

  if (command === "run") {
    const dir = resolveDir(args[1]);
    const config = await loadAgentConfig(dir);
    const token = await loadToken(dir);

    const abortController = new AbortController();
    const shutdown = () => abortController.abort();
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    const connector = new DiscordConnector({
      token,
      config,
      signal: abortController.signal,
      onReady: (username) => {
        console.log(`Agent Connector ready! Connected as ${username}`);
      },
    });

    const ipc = await startIpcServer(dir, shutdown);
    await connector.start();

    // Keep running until aborted
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener("abort", () => {
        connector.stop();
        ipc?.close();
        resolve();
      });
    });
    return;
  }

  if (command === "up") {
    const dir = resolveDir(args[1]);
    await loadAgentConfig(dir);
    await loadToken(dir);

    const exe = Deno.execPath();
    const child = new Deno.Command(exe, {
      args: ["run", "--allow-all", import.meta.url, "run", dir],
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).spawn();
    child.unref();

    const ready = await probeReady(dir, 6000);
    if (!ready) {
      console.error("Daemon started but IPC ready probe timed out.");
      Deno.exit(1);
    }
    console.log("Agent Connector started in background.");
    return;
  }

  if (command === "down") {
    const dir = resolveDir(args[1]);
    await stopDaemon(dir);
    return;
  }

  if (command === "auto") {
    const sub = args[1] || "list";
    if (sub === "add") {
      const dir = resolveDir(args[2]);
      await addAutostart(dir);
    } else if (sub === "remove" || sub === "rm" || sub === "delete") {
      const dir = resolveDir(args[2]);
      await removeAutostart(dir);
    } else if (sub === "list" || sub === "ls") {
      await listAutostart();
    } else {
      console.error("Usage:\n  agc auto add [DIR]\n  agc auto remove [DIR]\n  agc auto list");
      Deno.exit(1);
    }
    return;
  }

  // If path is passed directly
  const dir = resolveDir(args[0]);
  const config = await loadAgentConfig(dir);
  for (const [name, policy] of Object.entries(config.policies)) {
    await checkAgent(policy);
  }
  console.log(`Agent Connector verified for ${dir}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    Deno.exit(1);
  });
}
