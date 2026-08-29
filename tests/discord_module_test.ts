import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";

Deno.test("root Discord source is a PA module", async () => {
  const path = fromFileUrl(new URL("../discord.md", import.meta.url));
  const source = await Deno.readTextFile(path);
  assertStringIncludes(source, 'require("pa.host")');
  assertStringIncludes(source, "return { guide = document.Discord.Guide, context = context, request = request }");
  assert(!source.includes("discord.messages"));
});
