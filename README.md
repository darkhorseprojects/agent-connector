# Agent Connector

Agent Connector routes Discord conversations to Portable Agents policies. Every request uses a disposable direct Agent
process with raw stdin, NDJSON stdout, stderr diagnostics, and optional invocation limits.

## Connect

From a configuration directory:

```sh
agc connect .
```

`connect` creates the directory if necessary, asks for the bot token with echo disabled, validates the bot and
application, stores the token atomically in the platform credential directory, and prints a scoped invite link. If
`agent-connector.yaml` is absent, it atomically creates a starter with the derived identity and empty policy/route maps.
If YAML exists with missing identity IDs, it fills them; mismatches fail before writing.

Zinc ships a useful `agent-connector.yaml` with a complete policy and no Discord IDs. Running `agc connect .` in the
Zinc directory fills bot/application IDs. User, channel, and guild route IDs remain operator-selected.

## YAML

Configuration is strict YAML; unknown fields fail. A policy directory may be absolute or relative to the YAML directory.
Entries and mounts are safe relative source paths.

```yaml
version: 1
discord:
  application: "<discord-application-id>"
  bot: "<discord-bot-id>"
concurrency: 4
limits:
  pending_requests: 32
  frame_bytes: 1048576
  stderr_bytes: 1048576
  lifetime_ms: 600000
  rpc_bytes: 8388608
  rpc_timeout_ms: 30000
  output_messages: 32
policies:
  zinc:
    directory: "."
    entry: zinc.md
    mounts: {}
    lua_memory: 96MiB
    environment:
      PATH: PATH
      HOME: HOME
    runtime:
      maximum_model_calls: 32
      maximum_output_tokens: 4096
users: {}
channels: {}
guilds: {}
```

A policy environment mapping means `Agent variable: Connector service variable`. Connector materializes only selected
values, then adds its private reserved Discord grant. The PA SDK clears the child environment first. Policy mappings
cannot use `AGENT_CONNECTOR_*`.

The optional `runtime` YAML value is validated as portable data and serialized to JSON as `argv[2]`; `argv[1]` is the
actor. Connector does not interpret package-specific runtime fields. Optional Connector limits are unbounded when
absent; Discord protocol/platform invariants remain fixed.

```sh
agc check .
agc run .
```

## Scheduling and shutdown

An actor is one Discord user under one application and policy. A newer request interrupts that actor’s previous Agent.
Configured concurrency uses one semaphore; configured `pending_requests` limits distinct running/waiting actors. Absent
scheduling limits are unbounded.

Discord listeners, Agent fibers, grants, RPC, and client are scoped. Shutdown removes listeners, interrupts/reaps direct
Agent children, revokes grants, closes RPC, then destroys the client. PA makes no process-tree claim.

## Discord capability

Connector mounts `discord.md` as public `discord`. Zinc discovers it generically through sealed `package.loaded`; Zinc
contains no Discord-specific prompt logic.

```lua
local discord = require("discord")
return discord.request({ type = "createMessage", content = "hello" })
```

The random loopback grant fixes the channel and ownership context. Reads remain in that channel. Edit/delete require
grant-created messages; failed deletion retains ownership for retry. Reactions allow the triggering or grant-created
messages. Revocation becomes active before token removal: no REST call begins afterward, while already-started work may
finish. Mutation responses are minimal.

## Output

Reasoning renders as blockquotes, tools as fenced code, and responses as Discord Markdown. Rendering is sequential and
throttled. Whitespace-only output is discarded. Splitting always advances and preserves surrogate pairs and fence state.
Durable completion adds a result footer; temporary completion does not.

```sh
deno task check
deno task compile
```

Handwritten production in `discord.md`, `src/*.ts`, and `src/discord/*.ts` is limited to 899 nonblank lines.

License: AGPL-3.0-only.
