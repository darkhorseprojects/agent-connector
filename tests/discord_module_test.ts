import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";

Deno.test("root Discord source is a PA module", async () => {
  const path = fromFileUrl(new URL("../discord.md", import.meta.url));
  const source = await Deno.readTextFile(path);
  assertStringIncludes(source, 'require("pa.host")');
  assertStringIncludes(source, 'local document = require("pa.document")(source)');
  assertStringIncludes(source, "return { guide = table.concat(document.Discord.Guide");
  assert(!source.includes("discord.messages"));
});
