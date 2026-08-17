import { assertEquals } from "@std/assert";
import { deriveThreadTitle, DiscordMessageStream, splitDiscordMessage } from "../src/discord/format.ts";

Deno.test("splitter never exceeds the requested limit", () => {
  for (
    const text of [
      "x".repeat(501),
      `paragraph one\n\n${"word ".repeat(200)}`,
      `\`\`\`lua\n${"return 'value'\n".repeat(50)}\`\`\``,
      "😀".repeat(300),
    ]
  ) {
    const chunks = splitDiscordMessage(text, 100);
    if (chunks.some((chunk) => chunk.length > 100)) throw new Error("oversized Discord chunk");
    if (chunks.some((chunk) => /[\uD800-\uDBFF]$/.test(chunk.replace(/\n```$/, "")))) {
      throw new Error("split surrogate pair");
    }
  }
});

Deno.test("splitter preserves short messages and rejects tiny limits", () => {
  assertEquals(splitDiscordMessage(" hello ", 100), ["hello"]);
  assertEquals(splitDiscordMessage("", 100), []);
  let rejected = false;
  try {
    splitDiscordMessage("text", 8);
  } catch (error) {
    rejected = error instanceof RangeError;
  }
  assertEquals(rejected, true);
});

Deno.test("streaming splitter freezes completed chunks and balances fences", () => {
  const stream = new DiscordMessageStream(100);
  stream.append(`\`\`\`lua\n${"return 'first'\n".repeat(12)}`);
  const first = stream.snapshot();
  stream.append(`${"return 'second'\n".repeat(12)}\`\`\``);
  const second = stream.snapshot();

  assertEquals(second.slice(0, first.length - 1), first.slice(0, -1));
  assertEquals(second.every((chunk) => chunk.length <= 100), true);
  assertEquals(second.every((chunk) => (chunk.match(/```/g)?.length ?? 0) % 2 === 0), true);
});

Deno.test("thread title is bounded without splitting Unicode", () => {
  const title = deriveThreadTitle("😀".repeat(40), 31);
  assertEquals(title.length <= 31, true);
  assertEquals(/[\uD800-\uDBFF]…$/.test(title), false);
});
