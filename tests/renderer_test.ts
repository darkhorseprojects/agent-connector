import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DiscordRenderer, type RenderedMessage, type RenderTarget } from "../src/discord/renderer.ts";

type Options = { content: string; allowedMentions: { parse: never[] } };
class Message implements RenderedMessage {
  readonly edits: string[] = [];
  constructor(public content: string) {}
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

Deno.test("renderer streams blocks and appends durable footer", async () => {
  const target = new Target();
  const renderer = new DiscordRenderer(target, { outputMessages: 64 });
  await renderer.push({ type: "reasoning", text: "first\nnext" });
  await renderer.push({ type: "reasoning_complete", result: 2 });
  await renderer.push({ type: "tool_call", call: "a", code: "return 1", result: 3 });
  await renderer.push({ type: "tool_result", call: "a", text: "1", ok: true, result: 4 });
  await renderer.push({ type: "response", text: "answer" });
  await renderer.push({ type: "response_complete", result: 5 });
  await renderer.push({ type: "store", result: 5, start: 1 });
  await renderer.finish();
  assertEquals(target.messages.map((message) => message.content), [
    "> first\n> next",
    "```lua\nreturn 1\n```",
    "```text\n1\n```",
    "answer\n-# result #5 · start #1",
  ]);
});

Deno.test("temporary Done has no footer", async () => {
  const target = new Target();
  const renderer = new DiscordRenderer(target, { outputMessages: 4 });
  await renderer.push({ type: "response", text: "temporary" });
  await renderer.push({ type: "response_complete" });
  await renderer.push({ type: "done", durable: false });
  await renderer.finish();
  assertEquals(target.messages[0].content, "temporary");
});

Deno.test("renderer escapes fences, splits bounds, and serializes mutations", async () => {
  let active = 0;
  let maximum = 0;
  const target: RenderTarget = {
    async send(_options) {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return {
        async edit() {
          active++;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active--;
        },
      };
    },
  };
  const renderer = new DiscordRenderer(target, { outputMessages: 8 });
  await Promise.all([
    renderer.push({ type: "tool_call", call: "a", code: "return [[```]]", result: 2 }),
    renderer.push({ type: "tool_result", call: "a", text: "x".repeat(2500), ok: true, result: 3 }),
    renderer.push({ type: "response", text: "done" }),
    renderer.push({ type: "response_complete", result: 4 }),
    renderer.push({ type: "store", result: 4, start: 1 }),
  ]);
  await renderer.finish();
  assertEquals(maximum, 1);
});

Deno.test("renderer requires terminal and rejects following output", async () => {
  const renderer = new DiscordRenderer(new Target(), { outputMessages: 4 });
  await renderer.push({ type: "response", text: "partial" });
  await assertRejects(() => renderer.finish(), Error, "no terminal event");
  const complete = new DiscordRenderer(new Target(), { outputMessages: 4 });
  await complete.push({ type: "done", durable: false });
  await assertRejects(() => complete.push({ type: "response", text: "late" }), Error, "after terminal");
});

Deno.test("renderer enforces message count including Store footer", async () => {
  const target = new Target();
  const renderer = new DiscordRenderer(target, { outputMessages: 1 });
  await renderer.push({ type: "response", text: "answer" });
  await renderer.push({ type: "response_complete", result: 2 });
  await renderer.push({ type: "store", result: 2, start: 1 });
  await renderer.finish();
  assertStringIncludes(target.messages[0].content, "result #2");
  const overflow = new DiscordRenderer(new Target(), { outputMessages: 1 });
  await assertRejects(() => overflow.push({ type: "response", text: "x".repeat(2000) }));
});
