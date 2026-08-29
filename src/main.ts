import manifest from "../deno.json" with { type: "json" };
import { basename, join, resolve } from "@std/path";
import { Effect } from "effect";
import { type ConnectorConfig, parseConfig } from "./config.ts";
import { DiscordConnector } from "./connector.ts";
import { botInviteUrl, loadToken, readSecret, saveToken, validateToken } from "./discord/credentials.ts";
import { checkAgent } from "./runtime/invoke.ts";

async function directory(argument?: string): Promise<string> {
  return await Deno.realPath(resolve(Deno.cwd(), argument ?? "."));
}
async function config(path: string): Promise<ConnectorConfig> {
  return parseConfig(await Deno.readTextFile(join(path, "agent-connector.yaml")));
}
async function connect(args: string[]): Promise<void> {
  if (args.length > 1) throw new Error("usage: agc connect [DIRECTORY]");
  const path = await directory(args[0]);
  const settings = await config(path);
  const token = await readSecret("Discord bot token");
  const identity = await validateToken(token, settings.discord.bot, settings.discord.application);
  await saveToken(path, token);
  console.log(`Connected ${identity.botName}. Invite: ${botInviteUrl(identity.applicationId)}`);
}
async function check(args: string[]): Promise<void> {
  if (args.length > 1) throw new Error("usage: agc check [DIRECTORY]");
  const settings = await config(await directory(args[0]));
  for (const [name, policy] of Object.entries(settings.policies)) {
    await Effect.runPromise(checkAgent(policy));
    console.log(`${name}: ${policy.entry}`);
  }
}
async function run(args: string[]): Promise<void> {
  if (args.length > 1) throw new Error("usage: agc run [DIRECTORY]");
  const path = await directory(args[0]);
  const settings = await config(path);
  for (const policy of Object.values(settings.policies)) await Effect.runPromise(checkAgent(policy));
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Agent Connector interrupted"));
  Deno.addSignalListener("SIGINT", stop);
  if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", stop);
  const connector = new DiscordConnector({
    token: await loadToken(path),
    config: settings,
    signal: controller.signal,
    onReady: (user) => console.log(`${basename(path)} connected as ${user}`),
  });
  try {
    await connector.start();
    await new Promise<void>((done) => controller.signal.addEventListener("abort", () => done(), { once: true }));
  } finally {
    await connector.stop();
    Deno.removeSignalListener("SIGINT", stop);
    if (Deno.build.os !== "windows") Deno.removeSignalListener("SIGTERM", stop);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = Deno.args;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log("Usage: agc connect [DIRECTORY]\n       agc check [DIRECTORY]\n       agc run [DIRECTORY]");
    return;
  }
  if (["--version", "-V"].includes(command)) return console.log(manifest.version);
  const execute = ({ connect, check, run } as Record<string, (args: string[]) => Promise<void>>)[command];
  if (!execute) throw new Error(`unknown command: ${command}`);
  await execute(args);
}
if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
