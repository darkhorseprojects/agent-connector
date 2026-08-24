# Agent Connector

Agent Connector routes Discord messages to Portable Agents packages. It preserves routing precedence, actor FIFO through
final delivery and capability revocation, explicit global concurrency, automatic thread delivery, and fixed
first-message thread titles.

## Build

Clone Portable Agents beside this repository so Deno can resolve the linked SDK, then build:

```text
parent/
  agent-connector/
  portable-agents/
```

```sh
deno task check
deno task compile
```

The compiled executable embeds the SDK and has no runtime SDK dependency. The Portable Agents `agent` executable and
matching Lua 5.5 shared library must be available at runtime. The Connector executable, exact registration sources,
service examples, README, license, and third-party notices are written under `dist/`.

## Configuration

```yaml
version: 1

discord:
  application: "123456789012345678"
  bot: "234567890123456789"

concurrency: 4

limits:
  pending_requests: 64
  pending_per_actor: 4
  frame_bytes: 8388608
  output_messages: 64

policies:
  zinc:
    entry: zinc.md
    mounts:
      host: host.md
      design: design.md
      discord: /absolute/path/to/agent-connector/registrations/discord.md
    trusted_modules:
      - src.host
      - src.models
      - src.store
      - discord
    directory: /absolute/path/to/zinc
    lua_memory: 96MiB

users:
  "345678901234567890": zinc
channels:
  "456789012345678901": zinc
guilds:
  "567890123456789012": zinc
```

Every mount and trusted module is visible in policy YAML. Connector does not append Discord values during invocation.
Relative mount paths resolve in the agent package; external mount paths are absolute. Lua memory, concurrency, and every
Connector limit are required and have no defaults. Each invocation starts one disposable `agent` process with a fresh
package image and Lua state. The process runs with `cwd = policy.directory`; it never inherits the directory from which
Connector was launched.

`lua_memory` sets one total allocation-time budget for memory routed through Lua's allocator and separately bounds input
length. It includes the prepared Lua state but is not an RSS limit. Connector owns each direct `agent` process and
aborts it during shutdown or request cancellation. Deployment-level wall-clock and whole-process memory limits belong to
the service manager or container. Cancellation does not clean up descendants created by trusted Lua or native modules.

Direct messages route by user. Exact channels precede inherited thread-parent channels. Guild fallback requires a bot
mention. Bots, webhooks, and empty requests are ignored.

## Credentials and commands

```sh
agc connect /absolute/path/to/zinc
agc check /absolute/path/to/zinc
agc run /absolute/path/to/zinc
```

For a new configuration, `connect` asks for the exact entry, mounts, trusted modules, resource settings, and optional
routes. It validates Discord identity and runs `agent check` before writing the configuration and privately stored
token. It does not discover package files or infer Zinc capabilities. With an existing configuration, `connect`
validates every policy, optionally replaces the token, and prints the invite URL. Edit policy and route YAML directly,
then run `agc check`.

`run` stays attached. Shutdown stops admission, rejects queued work, aborts active `agent` processes, revokes RPC
capabilities, disconnects Discord, and exits.

## Discord registration

[`registrations/discord.md`](registrations/discord.md) is the single Discord source. It contains both the guide and
trusted implementation and returns one native Lua package value:

```lua
local discord = require("discord")
return discord.context
```

There is no separate Lua source, documentation registration, or guide RPC. The bot token remains in Connector. Each
active Run receives only an invocation-scoped loopback RPC URL and random bearer token. Revocation occurs before the
actor scheduler slot is released.

## Delivery

Agents emit strict NDJSON. Connector rejects mismatched stream completions, invalid continued tool sequences,
non-increasing durable IDs, and a Store result that is not the latest completed durable item. It renders reasoning as
blockquotes, tool calls as Lua fences, tool results as text fences, and response deltas as Markdown. Mutations are
serialized and provisional model deltas are coalesced to at most one Discord update per 400 ms per active block;
completion and semantic boundaries flush immediately.

Every Discord send disables mentions and obeys Discord's 2,000-character message constraint. Connector enforces one
configured frame limit for raw event lines and RPC requests/responses, plus the sent-message count. Exceeding one of
these limits stops the invocation, revokes its Discord capability, and reports a local incident. Already delivered
provisional output remains visible.

Reasoning and response text streams provisionally. `reasoning_complete` and `response_complete` identify the durable
record committed for each finished item; completed tool calls and results carry their record IDs directly. Connector
validates but does not render these completion IDs separately.

The terminal event is exactly `{ "type": "store", "result": N, "start": M }`, where `result` is the latest completed
durable item and `start` is the request record. The agent owns continuation policy; Connector accepts Store after
reasoning, a response, a tool call, or a tool result. Failed executions emit no synthetic Store event or partial status.
Previously streamed provisional output is not retracted.

Messages for one actor remain FIFO through thread creation, execution, rendering, Store footer, incident delivery, and
RPC revocation. Different actors share the explicitly configured number of execution slots. Waiting admission is bounded
by `pending_requests` globally and `pending_per_actor` for one actor. Capacity rejection sends
`Agent queue is full. Try again later.` without creating an incident.

## RPC

The authenticated loopback bridge provides invocation context and generic Discord REST requests. It validates methods,
Discord REST paths, query values, actual audit-reason constraints, files, authentication, revocation, required
`Content-Length`, and configured request/response bytes. The request-body bound also covers Base64 file data. It never
exposes the bot token.

## Background operation

Connector does not daemonize. Use the systemd, launchd, and Windows Task Scheduler examples under
[`packaging`](packaging).

## Failures

Discord receives only:

```text
Request failed. Incident: 12ab34cd
```

Local stderr contains the matching full error.

## License

[GNU Affero General Public License v3.0 only](LICENSE)
