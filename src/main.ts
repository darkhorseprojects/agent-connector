import manifest from "../deno.json" with { type: "json" };
import { join, resolve } from "@std/path";
import { Cause, Effect, Exit } from "effect";
import { checkAgent } from "./agent.ts";
import { configureIdentity, parseBootstrapConfig, parseConfig } from "./config.ts";
import { runConnector } from "./connector.ts";
import { botInviteUrl, loadToken, readSecret, saveToken, validateToken, writeAtomic } from "./discord/credentials.ts";

const CONFIG = "agent-connector.yaml";
async function directory(argument: string | undefined, create: boolean): Promise<string> {
  const path = resolve(Deno.cwd(), argument ?? ".");
  if (create) await Deno.mkdir(path, { recursive: true });
  return await Deno.realPath(path);
}
async function connect(path: string): Promise<void> {
  const token = await readSecret("Discord bot token");
  const current = await Deno.readTextFile(join(path, CONFIG)).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
  const previous = current === undefined ? undefined : parseBootstrapConfig(current, path);
  const identity = await validateToken(token, previous?.discord.bot, previous?.discord.application);
  const changed = current === undefined || !previous?.discord.bot || !previous.discord.application;
  if (changed) {
    await writeAtomic(
      join(path, CONFIG),
      configureIdentity(current, identity.applicationId, identity.botId),
      current === undefined,
      0o644,
    );
  }
  await saveToken(path, token);
  console.log(
    `Connected as ${identity.botName}\nInvite: ${botInviteUrl(identity.applicationId)}\nConfig: ${
      changed ? current === undefined ? "created" : "updated" : "unchanged"
    } ${join(path, CONFIG)}`,
  );
}
async function check(path: string): Promise<void> {
  const settings = parseConfig(await Deno.readTextFile(join(path, CONFIG)), path);
  for (const [name, policy] of Object.entries(settings.policies)) {
    await Effect.runPromise(checkAgent(policy));
    console.log(`${name}: ${policy.entry}`);
  }
}
async function run(path: string): Promise<void> {
  const settings = parseConfig(await Deno.readTextFile(join(path, CONFIG)), path);
  for (const policy of Object.values(settings.policies)) await Effect.runPromise(checkAgent(policy));
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Agent Connector interrupted"));
  const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  for (const signal of signals) Deno.addSignalListener(signal, stop);
  try {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(runConnector({ token: await loadToken(path), config: settings })),
      { signal: controller.signal },
    );
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause);
  } finally {
    for (const signal of signals) Deno.removeSignalListener(signal, stop);
  }
}
async function main(): Promise<void> {
  const [command, ...args] = Deno.args;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log("Usage: agc connect [DIRECTORY]\n       agc check [DIRECTORY]\n       agc run [DIRECTORY]");
    return;
  }
  if (["--version", "-V"].includes(command)) return console.log(manifest.version);
  if (args.length > 1) throw new Error(`usage: agc ${command} [DIRECTORY]`);
  const execute = ({ connect, check, run } as Record<string, (path: string) => Promise<void>>)[command];
  if (!execute) throw new Error(`unknown command: ${command}`);
  await execute(await directory(args[0], command === "connect"));
}
if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
