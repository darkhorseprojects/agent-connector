import { assertEquals } from "@std/assert";
import { type DiscordRest, DiscordRpcServer } from "../src/discord/rpc.ts";

type Call = { method: string; route: string; options: unknown };

function rest(calls: Call[]): DiscordRest {
  const invoke = (method: string) => (route: string, options?: unknown) => {
    calls.push({ method, route, options });
    return Promise.resolve({ id: "response", method });
  };
  return {
    get: invoke("GET"),
    post: invoke("POST"),
    put: invoke("PUT"),
    patch: invoke("PATCH"),
    delete: invoke("DELETE"),
  };
}

Deno.test("Discord RPC scopes context and forwards generic REST requests", async () => {
  const calls: Call[] = [];
  const server = new DiscordRpcServer(rest(calls), 8_388_608);
  const capability = server.grant({
    actor: "discord:actor",
    policy: "zinc",
    userId: "1",
    messageId: "2",
    channelId: "3",
    guildId: "4",
  });
  const url = capability.environment.AGENT_CONNECTOR_DISCORD_URL;
  const token = capability.environment.AGENT_CONNECTOR_DISCORD_TOKEN;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    const unauthorized = await fetch(`${url}/v1/context`);
    assertEquals(unauthorized.status, 401);

    const context = await fetch(`${url}/v1/context`, { headers });
    assertEquals(context.status, 200);
    assertEquals(await context.json(), {
      actor: "discord:actor",
      policy: "zinc",
      userId: "1",
      messageId: "2",
      channelId: "3",
      guildId: "4",
    });

    const response = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        method: "POST",
        route: "/channels/3/messages",
        query: { around: "5", limit: 2 },
        body: { content: "hello" },
        reason: "agent request",
        files: [{ name: "value.txt", data: "dmFsdWU=", contentType: "text/plain" }],
      }),
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { value: { id: "response", method: "POST" } });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].route, "/channels/3/messages");
    const options = calls[0].options as {
      body: unknown;
      query: URLSearchParams;
      reason: string;
      files: { data: Uint8Array; name: string; contentType: string }[];
    };
    assertEquals(options.body, { content: "hello" });
    assertEquals(options.query.toString(), "around=5&limit=2");
    assertEquals(options.reason, "agent request");
    assertEquals(new TextDecoder().decode(options.files[0].data), "value");

    capability.revoke();
    assertEquals((await fetch(`${url}/v1/context`, { headers })).status, 401);
  } finally {
    capability.revoke();
    await server.close();
  }
});

Deno.test("Discord RPC bounds request and response bodies", async () => {
  const calls: Call[] = [];
  const base = rest(calls);
  const server = new DiscordRpcServer({
    ...base,
    get: () => Promise.resolve("x".repeat(1_000)),
  }, 128);
  const capability = server.grant({
    actor: "a",
    policy: "p",
    userId: "1",
    messageId: "2",
    channelId: "3",
  });
  const url = capability.environment.AGENT_CONNECTOR_DISCORD_URL;
  const token = capability.environment.AGENT_CONNECTOR_DISCORD_TOKEN;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    const oversized = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ method: "GET", route: "/x", padding: "x".repeat(128) }),
    });
    assertEquals(oversized.status, 413);
    assertEquals(await oversized.json(), { error: "request exceeds configured byte limit" });

    const response = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ method: "GET", route: "/x" }),
    });
    assertEquals(response.status, 502);
    assertEquals(await response.json(), { error: "response exceeds configured byte limit" });

    const endpoint = new URL(url);
    const connection = await Deno.connect({ hostname: endpoint.hostname, port: Number(endpoint.port) });
    const request = new TextEncoder().encode(
      `POST /v1/request HTTP/1.1\r\nHost: ${endpoint.host}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
    );
    await connection.write(request);
    const source = new TextDecoder().decode(await new Response(connection.readable).arrayBuffer());
    assertEquals(source.startsWith("HTTP/1.1 411"), true);
  } finally {
    capability.revoke();
    await server.close();
  }
});

Deno.test("Discord RPC validates routes and explicit revocation", async () => {
  const calls: Call[] = [];
  const server = new DiscordRpcServer(rest(calls), 8_388_608);
  const capability = server.grant({
    actor: "a",
    policy: "p",
    userId: "1",
    messageId: "2",
    channelId: "3",
  });
  const url = capability.environment.AGENT_CONNECTOR_DISCORD_URL;
  const headers = {
    authorization: `Bearer ${capability.environment.AGENT_CONNECTOR_DISCORD_TOKEN}`,
    "content-type": "application/json",
  };
  try {
    for (
      const route of [
        "https://discord.com/api",
        "/../channels",
        "/%2e%2e/channels",
        "/%2Fchannels",
        "/%5Cchannels",
        "//other-origin",
        "/channels?x=1",
        "/channels#fragment",
      ]
    ) {
      const invalid = await fetch(`${url}/v1/request`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "GET", route }),
      });
      assertEquals(invalid.status, 400);
    }
    const valid = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ method: "GET", route: "/channels/123/messages" }),
    });
    assertEquals(valid.status, 200);
    assertEquals(calls[0].route, "/channels/123/messages");
    capability.revoke();
    assertEquals((await fetch(`${url}/v1/context`, { headers })).status, 401);
  } finally {
    capability.revoke();
    await server.close();
  }
});
