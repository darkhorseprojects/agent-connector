import { dirname, fromFileUrl, join } from "@std/path";

const root = fromFileUrl(new URL("..", import.meta.url));
const output = join(root, "dist", Deno.build.os === "windows" ? "agc.exe" : "agc");

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
    "--allow-ffi",
    "--include",
    "packages/discord",
    "--output",
    output,
    "src/main.ts",
  ],
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!status.success) throw new Error(`deno compile failed with status ${status.code}`);
for (
  const path of [
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "packaging/systemd/agc.service.example",
    "packaging/launchd/io.darkhorseprojects.agc.plist.example",
    "packaging/windows/install-agc-task.ps1",
    "packaging/windows/remove-agc-task.ps1",
  ]
) {
  const destination = join(root, "dist", path);
  await Deno.mkdir(dirname(destination), { recursive: true });
  await Deno.copyFile(join(root, path), destination);
}
for (
  const path of [
    output,
    join(root, "dist", "LICENSE"),
    join(root, "dist", "README.md"),
    join(root, "dist", "THIRD_PARTY_NOTICES.md"),
    join(root, "dist", "packaging", "systemd", "agc.service.example"),
    join(root, "dist", "packaging", "launchd", "io.darkhorseprojects.agc.plist.example"),
    join(root, "dist", "packaging", "windows", "install-agc-task.ps1"),
    join(root, "dist", "packaging", "windows", "remove-agc-task.ps1"),
  ]
) if (!(await Deno.stat(path)).isFile) throw new Error(`compiled distribution is missing ${path}`);
