import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";

const root = fromFileUrl(new URL("..", import.meta.url));
const portableRoot = fromFileUrl(new URL("../../portable-agents", import.meta.url));
const executableName = Deno.build.os === "windows" ? "agent.exe" : "agent";
const output = join(root, "dist", Deno.build.os === "windows" ? "agc.exe" : "agc");
const agentOutput = join(root, "dist", executableName);

await Deno.remove(join(root, "dist"), { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(join(root, "dist"), { recursive: true });
const status = await new Deno.Command(Deno.execPath(), {
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
}).output();
if (!status.success) throw new Error(`deno compile failed with status ${status.code}`);
await copy(join(portableRoot, "zig-out", "bin", executableName), agentOutput);
await copy(join(portableRoot, ".lux", "runtime"), join(root, "dist", ".lux", "runtime"));
await copy(join(portableRoot, "NOTICE"), join(root, "dist", "PORTABLE_AGENTS_NOTICE"));
await copy(join(root, "discord.md"), join(root, "dist", "discord.md"));
await copy(join(root, "packaging"), join(root, "dist", "packaging"));
for (const name of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
  await copy(join(root, name), join(root, "dist", name));
}
for (
  const path of [
    output,
    agentOutput,
    join(root, "dist", "discord.md"),
    join(root, "dist", "LICENSE"),
    join(root, "dist", "README.md"),
    join(root, "dist", "THIRD_PARTY_NOTICES.md"),
    join(root, "dist", "PORTABLE_AGENTS_NOTICE"),
    join(root, "dist", "packaging", "systemd", "agc.service.example"),
    join(root, "dist", "packaging", "launchd", "io.darkhorseprojects.agc.plist.example"),
    join(root, "dist", "packaging", "windows", "install-agc-task.ps1"),
    join(root, "dist", "packaging", "windows", "remove-agc-task.ps1"),
  ]
) if (!(await Deno.stat(path)).isFile) throw new Error(`compiled distribution is missing ${path}`);
