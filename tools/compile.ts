import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";

const root = fromFileUrl(new URL("..", import.meta.url));
const output = join(root, "dist", Deno.build.os === "windows" ? "agc.exe" : "agc");
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
await copy(join(root, "registrations"), join(root, "dist", "registrations"));
await copy(join(root, "packaging"), join(root, "dist", "packaging"));
for (const name of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
  await copy(join(root, name), join(root, "dist", name));
}
for (
  const path of [
    output,
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
