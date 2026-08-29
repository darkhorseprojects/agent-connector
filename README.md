# Agent Connector

Agent Connector routes Discord conversations to Portable Agents policies. Each turn runs in a disposable PA process with
explicit memory and wall-time limits.

## Configure

Create `agent-connector.yaml`:

```yaml
version: 1
discord:
  application: "<discord-application-id>"
  bot: "<discord-bot-id>"
concurrency: 4
limits:
  pending_requests: 32
  frame_bytes: 1048576
  output_messages: 32
policies:
  zinc:
    directory: "/absolute/path/to/zinc"
    entry: "zinc.md"
    mounts: {}
    trusted_modules:
      - "src.models"
      - "src.store"
      - "src.cygnet"
    lua_memory: "96MiB"
    process_memory: "512MiB"
    wall_time: "2m"
users: {}
channels: {}
guilds: {}
```

Route-map keys are Discord IDs and values are policy names. User routes handle direct messages. Channel routes handle
messages in that channel and its threads. Guild routes require a bot mention.

Connector automatically mounts its bundled root `discord.md` as `discord` and trusts that exact source. Policies must
not define a conflicting `discord` mount.

## Connect and run

```sh
agc connect /path/to/config-directory
agc check /path/to/config-directory
agc run /path/to/config-directory
```

`connect` requires the YAML file, securely reads a bot token, verifies the configured application and bot, stores the
token in the platform account-data directory, and prints an invite URL. Tokens never enter YAML.

## Conversations

An actor is one Discord user under one application and policy. If that actor sends another message while a turn is
running or waiting, Connector interrupts the older PA process, revokes its Discord grant, and starts only the newest
message. Completed durable Zinc records remain available to the new turn. Intentional supersession does not produce an
incident message.

Different actors run concurrently up to `concurrency`. `pending_requests` limits distinct active and waiting actors.

## Output

Connector renders events as they arrive:

- reasoning as `>` blockquotes;
- tool calls as `lua` code blocks;
- tool results as `text` code blocks;
- responses as normal Discord Markdown.

Streaming text is edited at a bounded interval. Message splitting preserves Markdown fences. Durable Store completion
adds a compact result footer; temporary Done completion adds none.

## Discord capability

Generated Lua can call:

```lua
local discord = require("discord")
return discord.request("POST", "/channels/" .. discord.context.channelId .. "/messages", {
    body = { content = "hello" },
})
```

The grant is random, loopback-only, bounded, and revoked when the invocation ends. While active it can use any Discord
REST route permitted to the bot. Context guidance is not a resource-level permission boundary.

## Distribution

A release contains `agc`, the matching `agent` launcher, root `discord.md`, PA's flattened `.lux/runtime`, service
examples, licenses, and notices.

```sh
deno task check
deno task compile
```

License: AGPL-3.0-only.
