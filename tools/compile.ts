import { copy, walk } from "@std/fs";
import { fromFileUrl, join } from "@std/path";

const root = fromFileUrl(new URL("..", import.meta.url));
const executableName = Deno.build.os === "windows" ? "agent.exe" : "agent";
const output = join(root, "dist", Deno.build.os === "windows" ? "agc.exe" : "agc");
const agentOutput = join(root, "dist", executableName);
const portableRoot = fromFileUrl(new URL("../../portable-agents", import.meta.url));
const agentSource = join(portableRoot, "zig-out", "bin", executableName);
const libraryName = Deno.build.os === "windows"
  ? "lua55.dll"
  : Deno.build.os === "darwin"
  ? "liblua55.dylib"
  : "liblua55.so";
let librarySource: string | undefined;
for await (const entry of walk(join(portableRoot, ".lua"), { includeDirs: false })) {
  if (entry.name !== libraryName) continue;
  if (librarySource) throw new Error(`Portable Agents Lua library is ambiguous: ${libraryName}`);
  librarySource = entry.path;
}
if (!librarySource) throw new Error(`Portable Agents Lua library is missing: ${libraryName}`);
await Deno.remove(join(root, "dist"), { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(join(root, "dist"), { recursive: true });
const command = new Deno.Command(Deno.execPath(), {
  cwd: root,
  args: [
    "compile",
    "--frozen",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-run",
    "--allow-env",
    "--output",
    output,
    "src/main.ts",
  ],
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
});
const status = await command.output();
if (!status.success) throw new Error(`deno compile failed with status ${status.code}`);
await copy(agentSource, agentOutput);
await copy(librarySource, join(root, "dist", libraryName));
await copy(join(root, "registrations"), join(root, "dist", "registrations"));
await copy(join(root, "packaging"), join(root, "dist", "packaging"));
for (const name of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
  await copy(join(root, name), join(root, "dist", name));
}
for (
  const path of [
    output,
    agentOutput,
    join(root, "dist", libraryName),
    join(root, "dist", "registrations", "discord.md"),
    join(root, "dist", "LICENSE"),
    join(root, "dist", "README.md"),
    join(root, "dist", "THIRD_PARTY_NOTICES.md"),
    join(root, "dist", "packaging", "systemd", "agc.service.example"),
    join(root, "dist", "packaging", "launchd", "io.darkhorseprojects.agc.plist.example"),
    join(root, "dist", "packaging", "windows", "install-agc-task.ps1"),
    join(root, "dist", "packaging", "windows", "remove-agc-task.ps1"),
  ]
) {
  if (!(await Deno.stat(path)).isFile) throw new Error(`compiled distribution is missing ${path}`);
}
