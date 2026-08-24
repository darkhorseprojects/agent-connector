import { assertEquals, assertStringIncludes } from "@std/assert";
import type { TextBasedChannel } from "discord.js";
import { reportIncident } from "../src/connector.ts";

Deno.test("incident delivery failure is logged once and never escapes", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    const target = {
      isSendable: () => true,
      send: () => Promise.reject(new Error("Discord unavailable")),
    } as unknown as TextBasedChannel;
    await reportIncident(target, new Error("agent failed"), "deadbeef");
  } finally {
    console.error = original;
  }
  assertEquals(lines.length, 2);
  assertStringIncludes(lines[0], "[deadbeef] Agent request failed");
  assertStringIncludes(lines[1], "[deadbeef] Incident delivery failed");
});
