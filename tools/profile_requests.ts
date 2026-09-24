type Observation = { stage: string; childUs: number; receivedMs: number; logWriteMs?: number };
type Profile = {
  readyMs: number;
  activeMs: number;
  totalMs: number;
  observations: Observation[];
  droppedStages: number;
  firstOutputReceivedMs?: number;
  firstSendStartedMs?: number;
  firstSendCompletedMs?: number;
  firstDeltaLogMs?: number;
};
type RecordLine = { id: string; caseName?: string; profiled?: boolean; profile?: Profile; outcome?: string };

if (Deno.args.length !== 1) throw new Error("usage: deno run --allow-read tools/profile_requests.ts REQUESTS.jsonl");
const profiles = (await Deno.readTextFile(Deno.args[0])).split("\n").filter(Boolean).map((line) =>
  JSON.parse(line) as RecordLine
).filter((row) => row.profile);
if (!profiles.length) throw new Error("no profile records found");

const groups = new Map<string, RecordLine[]>();
for (const row of profiles) {
  const name = row.caseName ?? row.id.match(/^local-(unprofiled|new|continuation)/)?.[1] ?? "connector";
  const selected = groups.get(name) ?? [];
  selected.push(row);
  groups.set(name, selected);
}
for (const [group, records] of groups) {
  console.log(`\n${group}`);
  for (
    const [label, select] of [
      ["ready", (p: Profile) => p.readyMs],
      ["queue + grant", (p: Profile) => p.activeMs - p.readyMs],
      ["first output frame received", (p: Profile) => p.firstOutputReceivedMs],
      [
        "first answer content received",
        (p: Profile) => p.observations.find((item) => item.stage === "model.chat.first_content")?.receivedMs,
      ],
      ["first Discord send", (p: Profile) => p.firstSendStartedMs],
      ["first Discord delivery", (p: Profile) => p.firstSendCompletedMs],
      ["total", (p: Profile) => p.totalMs],
    ] as const
  ) {
    const values = records.map((row) => select(row.profile!)).filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    if (values.length) {
      console.log(
        `  ${label}: n=${values.length} p50=${values[Math.ceil(values.length * 0.5) - 1].toFixed(1)}ms ` +
          `p95=${values[Math.ceil(values.length * 0.95) - 1].toFixed(1)}ms`,
      );
    }
  }
}

for (const row of profiles) {
  const profile = row.profile!;
  const active = new Map<string, number[]>();
  const spans: { name: string; begin: number; end: number; overlapping: boolean }[] = [];
  const unmatched: string[] = [];
  for (const observation of profile.observations) {
    const { stage, childUs } = observation;
    if (stage.endsWith(".begin")) {
      const name = stage.slice(0, -6);
      const starts = active.get(name) ?? [];
      starts.push(childUs);
      active.set(name, starts);
    } else if (stage.endsWith(".end")) {
      const name = stage.slice(0, -4);
      const starts = active.get(name);
      const begin = starts?.pop();
      if (begin === undefined) {
        if (stage !== "protocol.decode.end" && stage !== "image.compile.end") {
          unmatched.push(`${name}: missing begin`);
        }
      } else spans.push({ name, begin, end: childUs, overlapping: !!starts?.length });
    }
  }
  for (const [name, starts] of active) {
    for (const _ of starts) unmatched.push(`${name}: missing end`);
  }
  const first = (stage: string) => profile.observations.find((item) => item.stage === stage)?.childUs;
  const expected = row.profiled === false ? [] : [
    "protocol.decode.end",
    "image.compile.end",
    "store.open.end",
    "memory.open.end",
    "memory.context.end",
    "model.props.end",
    "model.prompt.end",
    "model.chat.begin",
  ];
  const missing = expected.filter((stage) => first(stage) === undefined);
  if (
    row.profiled !== false &&
    ["model.chat.first_reasoning", "model.chat.first_content", "model.chat.first_tool_argument"].every((stage) =>
      first(stage) === undefined
    )
  ) missing.push("first model delta");
  spans.sort((a, b) => a.begin - b.begin || b.end - a.end);
  let concurrent = 0;
  for (const span of spans.filter((value) => value.name.startsWith("eval.source."))) {
    if (
      spans.some((other) =>
        other !== span && other.name.startsWith("eval.source.") &&
        other.begin < span.end && span.begin < other.end
      )
    ) concurrent++;
  }
  console.log(
    `\n${row.id} (${row.outcome ?? "connector"}): ${profile.totalMs.toFixed(1)}ms, ` +
      `dropped=${profile.droppedStages}, overlapping Eval spans=${concurrent}`,
  );
  const prompt = first("model.chat.begin");
  for (const stage of ["model.chat.first_reasoning", "model.chat.first_content", "model.chat.first_tool_argument"]) {
    const at = first(stage);
    if (at !== undefined && prompt !== undefined) {
      console.log(`  ${stage}: ${((at - prompt) / 1000).toFixed(1)}ms after chat.begin (child clock)`);
    }
  }
  for (const span of spans) {
    const depth = spans.filter((other) =>
      other !== span && other.begin <= span.begin && other.end >= span.end &&
      other.end - other.begin > span.end - span.begin
    ).length;
    console.log(
      `  ${"  ".repeat(Math.min(depth, 5))}${span.name}: ${((span.end - span.begin) / 1000).toFixed(1)}ms` +
        (span.overlapping ? " [ambiguous concurrent pair]" : ""),
    );
  }
  const loggingMs = profile.observations.reduce((sum, item) => sum + (item.logWriteMs ?? 0), 0);
  if (loggingMs) console.log(`  awaited operator logging: ${loggingMs.toFixed(1)}ms (not additive to nested spans)`);
  if (profile.firstDeltaLogMs !== undefined) {
    console.log(`  first-delta log wait: ${profile.firstDeltaLogMs.toFixed(1)}ms`);
  }
  if (missing.length || unmatched.length) console.log(`  missing/incomplete: ${[...missing, ...unmatched].join(", ")}`);
}
