import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DiscordRenderer, type RenderedMessage, type RenderTarget } from "../src/discord/renderer.ts";

type Options = { content: string; allowedMentions: { parse: never[] } };
const limits = Object.freeze({ outputBytes: 1_048_576, outputMessages: 64 });

class Message implements RenderedMessage {
  content: string;
  readonly edits: string[] = [];

  constructor(content: string) {
    this.content = content;
  }

  edit(options: Options): Promise<void> {
    assertEquals(options.allowedMentions.parse, []);
    this.content = options.content;
    this.edits.push(options.content);
    return Promise.resolve();
  }
}

class Target implements RenderTarget {
  readonly messages: Message[] = [];

  send(options: Options): Promise<Message> {
    assertEquals(options.allowedMentions.parse, []);
    const message = new Message(options.content);
    this.messages.push(message);
    return Promise.resolve(message);
  }
}

Deno.test("renderer streams semantic blocks and appends Store footer", async () => {
  const target = new Target();
  const renderer = new DiscordRenderer(target, limits);
  await renderer.push({ type: "reasoning", text: "first " });
  await renderer.push({ type: "reasoning", text: "thought\n\nnext" });
  await renderer.push({ type: "reasoning_complete", result: 43 });
  await renderer.push({ type: "tool_call", code: "return 1", result: 44 });
  await renderer.push({ type: "tool_result", text: "1", ok: true, result: 45 });
  await renderer.push({ type: "response", text: "answer " });
  await renderer.push({ type: "response", text: "done" });
  await renderer.push({ type: "response_complete", result: 46 });
  await renderer.push({ type: "store", result: 46, start: 42 });
  await renderer.finish();

  assertEquals(target.messages.length, 4);
  assertEquals(target.messages[0].content, "> first thought\n>\n> next");
  assertEquals(target.messages[0].edits.length > 0, true);
  assertEquals(target.messages[1].content, "```lua\nreturn 1\n```");
  assertEquals(target.messages[2].content, "```text\n1\n```");
  assertEquals(target.messages[3].content, "answer done\n-# result #46 · start #42");
});

Deno.test("renderer splits large Markdown and preserves Discord bounds", async () => {
  const target = new Target();
  const renderer = new DiscordRenderer(target, limits);
  await renderer.push({ type: "response", text: `# Result\n\n${"word ".repeat(1400)}` });
  await renderer.push({ type: "store", result: 7, start: 1 });
  await renderer.finish();

  assertEquals(target.messages.length > 1, true);
  assertEquals(target.messages.every((message) => message.content.length <= 2000), true);
  assertStringIncludes(target.messages.at(-1)!.content, "-# result #7 · start #1");
});

Deno.test("renderer escapes nested fences and can send Store alone", async () => {
  const target = new Target();
  const renderer = new DiscordRenderer(target, limits);
  await renderer.push({ type: "tool_call", code: "return [[```]]", result: 1 });
  await renderer.push({ type: "store", result: 1, start: 1 });
  await renderer.finish();
  assertStringIncludes(target.messages[0].content, "``\u200b`");
  assertEquals(target.messages[1].content, "-# result #1 · start #1");
});

Deno.test("renderer requires Store and rejects output after it", async () => {
  const renderer = new DiscordRenderer(new Target(), limits);
  await renderer.push({ type: "response", text: "partial" });
  await assertRejects(() => renderer.finish(), Error, "no terminal Store");

  const complete = new DiscordRenderer(new Target(), limits);
  await complete.push({ type: "store", result: 1, start: 1 });
  let rejected = false;
  try {
    await complete.push({ type: "response", text: "late" });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("after Store");
  }
  assertEquals(rejected, true);
});

Deno.test("renderer coalesces immediate model fragments", async () => {
  const target = new Target();
  const renderer = new DiscordRenderer(target, limits);
  for (let index = 0; index < 1000; index++) {
    await renderer.push({ type: "response", text: "x" });
  }
  await renderer.push({ type: "response_complete", result: 1 });
  await renderer.push({ type: "store", result: 1, start: 1 });
  await renderer.finish();

  assertEquals(target.messages.length, 1);
  assertEquals(target.messages[0].edits.length < 10, true);
  assertEquals(target.messages[0].content.endsWith("-# result #1 · start #1"), true);
  assertEquals(target.messages[0].content.match(/-# result/g)?.length, 1);
});

Deno.test("renderer serializes slow Discord mutations", async () => {
  let active = 0;
  let maximumActive = 0;
  const mutate = async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
  };
  const target: RenderTarget = {
    async send(_options) {
      await mutate();
      return {
        async edit(_next) {
          await mutate();
        },
      };
    },
  };
  const renderer = new DiscordRenderer(target, limits);
  await Promise.all([
    renderer.push({ type: "response", text: "one" }),
    renderer.push({ type: "response", text: " two" }),
    renderer.push({ type: "response_complete", result: 1 }),
    renderer.push({ type: "store", result: 1, start: 1 }),
  ]);
  await renderer.finish();
  assertEquals(maximumActive, 1);
});

Deno.test("renderer enforces cumulative UTF-8 output bytes", async () => {
  const exact = new DiscordRenderer(new Target(), { outputBytes: 4, outputMessages: 2 });
  await exact.push({ type: "response", text: "😀" });
  await exact.push({ type: "store", result: 1, start: 1 });
  await exact.finish();

  const exceeded = new DiscordRenderer(new Target(), { outputBytes: 3, outputMessages: 2 });
  await assertRejects(
    () => exceeded.push({ type: "response", text: "😀" }),
    Error,
    "exceeds configured byte limit",
  );
});

Deno.test("renderer enforces the sent-message count", async () => {
  const target = new Target();
  const renderer = new DiscordRenderer(target, { outputBytes: 100, outputMessages: 1 });
  await renderer.push({ type: "tool_call", code: "return 1", result: 1 });
  await assertRejects(
    () => renderer.push({ type: "tool_result", text: "1", ok: true, result: 2 }),
    Error,
    "exceeds configured message limit",
  );
  assertEquals(target.messages.length, 1);
});
