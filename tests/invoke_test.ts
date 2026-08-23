import { assertEquals, assertRejects } from "@std/assert";
import { dirname } from "@std/path";
import { type AgentEvent, parseAgentOutput as parseBoundedAgentOutput, runAgent } from "../src/runtime/invoke.ts";

const encoder = new TextEncoder();
const MAXIMUM_EVENT_BYTES = 1_048_576;

function chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value;
    },
  };
}

function parseAgentOutput(
  output: AsyncIterable<Uint8Array>,
  maximum = MAXIMUM_EVENT_BYTES,
): AsyncIterable<AgentEvent> {
  return parseBoundedAgentOutput(output, maximum);
}

async function collect(output: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of output) result.push(event);
  return result;
}

Deno.test({
  name: "agent runs in the policy directory",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "connector-cwd-" });
    try {
      await Deno.writeTextFile(`${root}/marker.txt`, "policy-directory");
      await Deno.writeTextFile(
        `${root}/entry.lua`,
        `local file=assert(io.open("marker.txt","rb"))
local value=assert(file:read("a")); assert(file:close())
coroutine.yield('{"type":"response","text":"'..value..'"}\\n')
coroutine.yield('{"type":"response_complete","result":1}\\n')
coroutine.yield('{"type":"store","result":1,"start":1}\\n')`,
      );
      const events = await collect(runAgent(
        {
          entry: "entry.lua",
          mounts: [],
          trustedModules: ["entry"],
          directory: root,
          luaMemory: "96MiB",
        },
        "actor",
        "request",
        MAXIMUM_EVENT_BYTES,
        undefined,
        { PATH: `${dirname(Deno.env.get("AGENT_BIN") ?? "agent")}:${Deno.env.get("PATH") ?? ""}` },
      ));
      assertEquals(events[0], { type: "response", text: "policy-directory" });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("agent parser reconstructs UTF-8 and NDJSON across every byte", async () => {
  const source = encoder.encode(
    '{"type":"reasoning","text":"😀"}\n' +
      '{"type":"reasoning_complete","result":42}\n' +
      '{"type":"tool_call","code":"return 1","result":43}\n' +
      '{"type":"tool_result","text":"1","ok":true,"result":44}\n' +
      '{"type":"response","text":"done"}\n' +
      '{"type":"response_complete","result":45}\n' +
      '{"type":"store","result":45,"start":42}\n',
  );
  const bytes = [...source].map((value) => new Uint8Array([value]));
  assertEquals(await collect(parseAgentOutput(chunks(...bytes))), [
    { type: "reasoning", text: "😀" },
    { type: "reasoning_complete", result: 42 },
    { type: "tool_call", code: "return 1", result: 43 },
    { type: "tool_result", text: "1", ok: true, result: 44 },
    { type: "response", text: "done" },
    { type: "response_complete", result: 45 },
    { type: "store", result: 45, start: 42 },
  ]);
});

Deno.test("agent parser requires an exact terminal Store event", async () => {
  await assertRejects(
    () =>
      collect(
        parseAgentOutput(
          chunks(encoder.encode('{"type":"response","text":"x"}\n{"type":"response_complete","result":1}\n')),
        ),
      ),
    Error,
    "no terminal Store",
  );
  await assertRejects(
    () =>
      collect(
        parseAgentOutput(
          chunks(
            encoder.encode(
              '{"type":"response","text":"x"}\n' +
                '{"type":"response_complete","result":1}\n' +
                '{"type":"store","result":1,"start":1}\n' +
                '{"type":"response","text":"late"}\n',
            ),
          ),
        ),
      ),
    Error,
    "follows the terminal",
  );
  await assertRejects(
    () => collect(parseAgentOutput(chunks(encoder.encode('{"type":"store","result":1,"start":1}')))),
    Error,
    "incomplete",
  );
});

Deno.test("agent parser enforces event sequencing", async () => {
  for (
    const [value, message] of [
      ['{"type":"store","result":1,"start":1}\n', "no completed durable item"],
      [
        '{"type":"reasoning","text":"x"}\n' +
        '{"type":"response_complete","result":1}\n',
        "no matching response stream",
      ],
      ['{"type":"response_complete","result":1}\n', "no matching response stream"],
      [
        '{"type":"response","text":"x"}\n' +
        '{"type":"store","result":1,"start":1}\n',
        "before response_complete",
      ],
      ['{"type":"tool_result","text":"x","ok":true,"result":1}\n', "no matching tool_call"],
      [
        '{"type":"response","text":"x"}\n' +
        '{"type":"response_complete","result":1}\n' +
        '{"type":"tool_call","code":"return 1","result":2}\n' +
        '{"type":"store","result":1,"start":1}\n',
        "latest completed item",
      ],
      [
        '{"type":"response","text":"x"}\n' +
        '{"type":"response_complete","result":2}\n' +
        '{"type":"tool_call","code":"return 1","result":1}\n',
        "must increase",
      ],
      [
        '{"type":"response","text":"x"}\n' +
        '{"type":"response_complete","result":2}\n' +
        '{"type":"store","result":3,"start":1}\n',
        "does not match the latest completed item",
      ],
    ] as const
  ) {
    await assertRejects(() => collect(parseAgentOutput(chunks(encoder.encode(value)))), Error, message);
  }
});

Deno.test("Store may terminate after any latest completed durable item", async () => {
  for (
    const value of [
      '{"type":"reasoning","text":"think"}\n{"type":"reasoning_complete","result":2}\n{"type":"store","result":2,"start":1}\n',
      '{"type":"tool_call","code":"return 1","result":2}\n{"type":"store","result":2,"start":1}\n',
      '{"type":"tool_call","code":"return 1","result":2}\n{"type":"tool_result","text":"1","ok":true,"result":3}\n{"type":"store","result":3,"start":1}\n',
    ]
  ) {
    const events = await collect(parseAgentOutput(chunks(encoder.encode(value))));
    assertEquals(events.at(-1)?.type, "store");
  }
});

Deno.test("agent parser accepts gaps in nested durable identifiers", async () => {
  const value = '{"type":"reasoning","text":"think"}\n' +
    '{"type":"reasoning_complete","result":10}\n' +
    '{"type":"tool_call","code":"return 1","result":20}\n' +
    '{"type":"tool_result","text":"1","ok":true,"result":35}\n' +
    '{"type":"response","text":"done"}\n' +
    '{"type":"response_complete","result":50}\n' +
    '{"type":"store","result":50,"start":10}\n';
  const events = await collect(parseAgentOutput(chunks(encoder.encode(value))));
  assertEquals(events.at(-1), { type: "store", result: 50, start: 10 });
});

Deno.test("agent parser rejects malformed events and transport", async () => {
  for (
    const [value, message] of [
      ['{"type":"response","text":"x","extra":1}\n', "Received one or more errors"],
      ['{"type":"store","result":1,"start":2}\n', "no completed durable item"],
      ['{"type":"unknown"}\n', "unknown agent event type"],
      ["\n", "empty event line"],
    ] as const
  ) {
    await assertRejects(() => collect(parseAgentOutput(chunks(encoder.encode(value)))), Error, message);
  }
  await assertRejects(
    () => collect(parseAgentOutput(chunks(new Uint8Array([0xFF, 0x0A])))),
    Error,
    "not valid UTF-8",
  );
  await assertRejects(
    () => collect(parseAgentOutput(chunks(new Uint8Array([0])))),
    Error,
    "contains NUL",
  );
});

Deno.test("agent parser enforces the raw event-line byte limit", async () => {
  const response = JSON.stringify({ type: "response", text: "x".repeat(64) });
  const output = encoder.encode(
    `${response}\n{"type":"response_complete","result":1}\n{"type":"store","result":1,"start":1}\n`,
  );
  const events = await collect(parseAgentOutput(chunks(output), encoder.encode(response).length));
  assertEquals((events[0] as { text: string }).text.length, 64);
  await assertRejects(
    () => collect(parseAgentOutput(chunks(output), encoder.encode(response).length - 1)),
    Error,
    "exceeds configured byte limit",
  );
});
