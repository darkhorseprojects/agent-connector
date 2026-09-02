# Agent Connector

Agent Connector routes Discord conversations to Portable Agents policies. Each request runs in a disposable Agent process with bounded JSONL
transport. The service manager owns outer process and wall-time policy.

## Configure

Create `agent-connector.json`:

```json
{
  "version": 1,
  "discord": { "application": "<discord-application-id>", "bot": "<discord-bot-id>" },
  "concurrency": 4,
  "limits": { "pendingRequests": 32, "frameBytes": 1048576, "outputMessages": 32 },
  "policies": {
    "zinc": { "directory": "/absolute/path/to/zinc", "entry": "zinc.md", "mounts": {}, "luaMemory": "96MiB" }
  },
  "users": {},
  "channels": {},
  "guilds": {}
}
```

Configuration is strict JSON. Unknown fields fail. Policy directories are absolute; entries and configured mounts are safe relative source
paths. Route-map keys are Discord IDs and values are policy names.

```sh
agc connect /path/to/config-directory
agc check /path/to/config-directory
agc run /path/to/config-directory
```

`connect` reads the token directly from the terminal with echo disabled, verifies its bot and application, and writes it atomically to the
platform credential directory. The token never enters configuration or process arguments.

## Scheduling

An actor is one Discord user under one application and policy. A newer request interrupts that actor's previous Agent process. Different
actors run up to `concurrency`; `pendingRequests` limits distinct running and waiting actors. Grants, renderer state, child processes, and
fibers are scoped and cleaned during interruption and shutdown.

## Discord capability

Connector mounts `discord.md` as `discord`. The capability accepts tagged operations:

```lua
local discord = require("discord")
return discord.request({ type = "createMessage", content = "hello" })
```

Connector constructs every Discord route from the immutable grant context. Reads stay in the granted channel. Edit and delete apply only to
messages created by the same grant. Reactions apply to the triggering message or grant-created messages. Request, response, frame,
attachment, and output-message limits are enforced. Revocation removes the random loopback bearer token.

## Output

Reasoning is rendered as blockquotes, tool calls and results as fenced code, and responses as Discord Markdown. The Agent stream drives
updates sequentially and throttles edits. Splitting preserves Unicode pairs and Markdown fence state. Durable completion adds a result
footer; temporary completion does not.

```sh
deno task check
deno task compile
```

License: AGPL-3.0-only.
