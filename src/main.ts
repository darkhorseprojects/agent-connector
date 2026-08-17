import manifest from "../deno.json" with { type: "json" };
import { basename, join, resolve } from "@std/path";
import { type ConnectorConfig, parseConfig } from "./config.ts";
import { DiscordConnector } from "./connector.ts";
import { loadToken } from "./discord/credentials.ts";
import { checkAgent } from "./runtime/invoke.ts";
import { connectExistingConfig, setupNewConfig } from "./setup.ts";

async function loadConfig(directory: string): Promise<ConnectorConfig> {
  return parseConfig(await Deno.readTextFile(join(directory, "agent-connector.yaml")));
}

async function resolveDirectory(argument?: string): Promise<string> {
  return await Deno.realPath(resolve(Deno.cwd(), argument ?? "."));
}

async function connect(args: string[]): Promise<void> {
  if (args.length > 1) throw new Error("usage: agc connect [DIRECTORY]");
  const directory = await resolveDirectory(args[0]);
  try {
    await connectExistingConfig(directory, await loadConfig(directory));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await setupNewConfig(directory);
  }
}

async function check(args: string[]): Promise<void> {
  if (args.length > 1) throw new Error("usage: agc check [DIRECTORY]");
  const directory = await resolveDirectory(args[0]);
  const config = await loadConfig(directory);
  for (const [name, policy] of Object.entries(config.policies)) {
    await checkAgent(policy);
    console.log(`${name}: ${policy.entry}`);
  }
}

async function run(args: string[]): Promise<void> {
  if (args.length > 1) throw new Error("usage: agc run [DIRECTORY]");
  const directory = await resolveDirectory(args[0]);
  const config = await loadConfig(directory);
  const token = await loadToken(directory);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Agent Connector interrupted."));
  Deno.addSignalListener("SIGINT", stop);
  if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", stop);

  const connector = new DiscordConnector({
    token,
    config,
    signal: controller.signal,
    onReady: (user) => console.log(`${basename(directory)} connected as ${user}`),
  });

  try {
    await connector.start();
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally {
    await connector.stop();
    Deno.removeSignalListener("SIGINT", stop);
    if (Deno.build.os !== "windows") Deno.removeSignalListener("SIGTERM", stop);
  }
}

const commands: Readonly<Record<string, (args: string[]) => Promise<void>>> = Object.freeze({ connect, check, run });

async function main(): Promise<void> {
  const [command, ...args] = Deno.args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(`Agent Connector v1

Usage:
  agc connect [DIRECTORY]
  agc check [DIRECTORY]
  agc run [DIRECTORY]`);
    return;
  }
  if (command === "--version" || command === "-V") {
    console.log(manifest.version);
    return;
  }
  const action = commands[command];
  if (!action) throw new Error(`unknown command: ${command}`);
  await action(args);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
