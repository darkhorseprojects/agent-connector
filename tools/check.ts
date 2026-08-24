import { fromFileUrl, join } from "@std/path";
import { PORTABLE_AGENTS_VERSION, verifyAgentVersion } from "../src/runtime/invoke.ts";

const root = fromFileUrl(new URL("..", import.meta.url));
const portableAgents = join(root, "..", "portable-agents");
const portableManifest = JSON.parse(await Deno.readTextFile(join(portableAgents, "deno.json"))) as {
  version?: unknown;
};
if (portableManifest.version !== PORTABLE_AGENTS_VERSION) {
  throw new Error(
    `Portable Agents SDK ${PORTABLE_AGENTS_VERSION} is required; found ${String(portableManifest.version)}`,
  );
}
await verifyAgentVersion();

for (
  const args of [
    ["fmt", "--check"],
    ["lint"],
    ["check", "src/main.ts"],
    ["test", "--frozen", "--allow-read", "--allow-write", "--allow-env", "--allow-run", "--allow-net", "tests"],
    ["run", "--frozen", "--allow-read", "--allow-write", "--allow-run", "tools/compile.ts"],
  ]
) {
  const child = new Deno.Command(Deno.execPath(), {
    cwd: root,
    args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  if (!status.success) throw new Error(`deno ${args.join(" ")} failed with status ${status.code}`);
}
