import { assertEquals, assertStringIncludes } from "@std/assert";
import { getCredentialPath, loadToken, saveToken } from "../src/discord/credentials.ts";

Deno.test("credentials ignore relative XDG paths and replace tokens atomically", async () => {
  const root = await Deno.makeTempDir({ prefix: "agent-connector-credentials-" });
  const packageDirectory = `${root}/package`;
  await Deno.mkdir(packageDirectory);
  const previousHome = Deno.env.get("HOME");
  const previousProfile = Deno.env.get("USERPROFILE");
  const previousXdg = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("HOME", root);
  Deno.env.set("USERPROFILE", root);
  Deno.env.set("XDG_CONFIG_HOME", "relative-config");
  try {
    const path = await getCredentialPath(packageDirectory);
    if (Deno.build.os === "linux") assertStringIncludes(path, `${root}/.config/agent-connector/credentials/`);
    await saveToken(packageDirectory, "first");
    await saveToken(packageDirectory, "second");
    assertEquals(await loadToken(packageDirectory), "second");
    const files = [...Deno.readDirSync(path.slice(0, path.lastIndexOf(Deno.build.os === "windows" ? "\\" : "/")))];
    assertEquals(files.filter((entry) => entry.name.startsWith(".discord-token-")).length, 0);
    if (Deno.build.os !== "windows") assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  } finally {
    restore("HOME", previousHome);
    restore("USERPROFILE", previousProfile);
    restore("XDG_CONFIG_HOME", previousXdg);
    await Deno.remove(root, { recursive: true });
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}
