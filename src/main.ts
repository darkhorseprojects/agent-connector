import manifest from "../deno.json" with { type: "json" };
import { join, resolve } from "@std/path";
import { Cause, Effect, Exit } from "effect";
import { checkAgent } from "./agent.ts";
import { emptyConfig, parseConfig } from "./config.ts";
import { runConnector } from "./connector.ts";
import {
  botInviteUrl,
  loadCredential,
  readSecret,
  registerCommand,
  saveCredential,
  validateToken,
} from "./discord/credentials.ts";

const CONFIG = "ac.yaml";

async function directory(argument: string | undefined, create: boolean): Promise<string> {
  const path = resolve(Deno.cwd(), argument ?? ".");
  if (create) await Deno.mkdir(path, { recursive: true });
  return await Deno.realPath(path);
}

async function connect(path: string): Promise<void> {
  const configPath = join(path, CONFIG);
  let source: string;
  try {
    source = await Deno.readTextFile(configPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    source = emptyConfig();
    await Deno.writeTextFile(configPath, source, { createNew: true, mode: 0o644 });
  }
  parseConfig(source, path, true);
  const token = await readSecret("Discord bot token");
  const identity = await validateToken(token);
  await registerCommand(token, identity.application);
  await saveCredential(path, { token, application: identity.application, bot: identity.bot });
  console.log(
    `Connected as ${identity.botName}\nInvite: ${botInviteUrl(identity.application)}\nConfig: ${configPath}`,
  );
}

async function settings(path: string) {
  const [source, credential] = await Promise.all([
    Deno.readTextFile(join(path, CONFIG)),
    loadCredential(path),
  ]);
  return {
    ...parseConfig(source, path),
    identity: { application: credential.application, bot: credential.bot },
    token: credential.token,
  };
}

async function check(path: string): Promise<void> {
  const config = parseConfig(await Deno.readTextFile(join(path, CONFIG)), path);
  for (const [name, policy] of Object.entries(config.policies)) {
    await Effect.runPromise(checkAgent(policy));
    console.log(`${name}: ${policy.sourceDir}#${policy.entryModule}`);
  }
}

async function run(path: string): Promise<void> {
  const config = await settings(path);
  for (const policy of Object.values(config.policies)) await Effect.runPromise(checkAgent(policy));
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Agent Connector interrupted"));
  const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  for (const signal of signals) Deno.addSignalListener(signal, stop);
  try {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(runConnector({ token: config.token, config })),
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
