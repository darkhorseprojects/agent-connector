import { fromFileUrl } from "@std/path";

const root = fromFileUrl(new URL("..", import.meta.url));
for (
  const args of [
    ["fmt", "--check"],
    ["lint"],
    ["check", "src/main.ts"],
    ["test", "--frozen", "--allow-read", "--allow-write", "--allow-env", "--allow-run", "--allow-net", "tests"],
    ["run", "--frozen", "--allow-read", "--allow-write", "--allow-run", "tools/compile.ts"],
  ]
) {
  const status = await new Deno.Command(Deno.execPath(), {
    cwd: root,
    args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`deno ${args.join(" ")} failed with status ${status.code}`);
}
