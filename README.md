# Agent Connector

Agent Connector routes Discord messages to Portable Agents policies. It passes the message as raw UTF-8 input, applies a
one-call overlay to the policy's opaque JSON config, supplies configured PA Imports, and renders incremental and final
Agent bytes as Discord Markdown.

## Connect

From a directory containing `ac.yaml`:

```sh
agc connect .
agc check .
agc run .
```

`connect` prompts for the Discord bot token, validates its bot/application identity, registers the global `/agent`
command, and stores the token and public identity in the native OS credential store. It uses macOS Keychain, Windows
Credential Manager, or Linux Secret Service. There is no plaintext credential fallback. The token never enters `ac.yaml`
or an Agent process.

## Configuration

Configuration is strict YAML. Unknown fields fail. Named policies are reusable as roots or leaf Imports. Routes map
Discord snowflakes to policy names.

```yaml
version: 1
concurrency: 4
limits:
  pending_requests: 32
  lifetime_ms: 600000
  rpc_bytes: 8388608
  output_messages: 32
policies:
  zinc:
    source: package
    entry: zinc
    memory_bytes: 100663296
    environment:
      - HOME
      - LUA_PATH
      - LUA_CPATH
      - LD_LIBRARY_PATH
      - DYLD_LIBRARY_PATH
      - PATH
      - SystemRoot
    discord: true
    imports: {}
    config:
      version: 1
      actor: "discord:${application}:${policy}:member:${member}:channel:${channel}"
      preset: safe
      quota: null
      imports:
        discord: "Discord capability for channel ${channel}."
members: {}
channels: {}
guilds: {}
```

`directory` is optional and defaults to the directory containing `ac.yaml`; `source` is relative to it. Only listed
environment variables are copied into the exact Agent process environment. `AGENT_CONNECTOR_*` names are reserved.

Config strings may use `${application}`, `${policy}`, `${member}`, `${channel}`, `${guild}`, and `${message}`. Connector
expands strings but does not interpret the resulting agent config.

A policy can import another leaf policy:

```yaml
imports:
  research:
    policy: research
    config:
      actor: research-account
```

The edge config recursively overlays the imported policy's config. `discord: true` separately supplies the built-in
Import named `discord`; it does not modify the agent's opaque config or its own `imports` field.

## Routing

Configured channel or thread-parent routes take precedence, followed by member routes, then guild routes. DMs require a
member route. Configured channels receive ordinary messages directly; member and guild routes in a guild require a bot
mention. Empty maps deny access.

A newer request interrupts the same policy/member/channel request. Global concurrency and pending-request limits apply
across message and command invocations.

## Per-call config

The registered command accepts a prompt and optional YAML object:

```text
/agent prompt:"Investigate this" config:"quota: 12000"
```

Connector recursively overlays this object onto the policy config for that call. Objects merge; arrays, scalars, and
`null` replace. Any config key may be changed. The selected Agent owns validation and meaning. The override is not
persisted and never modifies `ac.yaml`.

## Output

Connector uses PA protocol 1 streaming. Every `pa.emit(bytes)` frame and the terminal Agent output are treated as
Markdown and rendered immediately in order. Connector only splits Discord messages safely, preserves fenced blocks,
disables mentions, and enforces `output_messages`; it defines no reasoning, tool, Store, or continuation schema.

Agents invoked through final-only `Agent.call` can use `pa.emit` safely because it is a no-op when emissions are
disabled.

## Discord Import

`package/discord.md` is an optional PA Import that proxies scoped Discord operations for Lua. Its loopback grant permits
reads in the selected channel, creation of messages, edits/deletes of grant-created messages, reactions to the
triggering or grant-created message, and bounded attachments. Revocation prevents new calls.

An agent decides how to expose the Import. Zinc exposes configured Imports to generated Lua as:

```lua
local result = self.agents.discord.call({ type = "createMessage", content = "hello" })
return result.id
```

## Development

Connector uses the sibling `../portable-agents` workspace package and binary.

```sh
cd ../portable-agents
zig build -Doptimize=ReleaseSafe -Dsystem-lua=true
cd ../agent-connector
deno task check
deno task compile
```

Standalone compilation embeds the native keyring addon and requires FFI permission. Zinc additionally needs
ABI-compatible Lua 5.5 and its Lua/native module paths in the selected environment.

License: AGPL-3.0-only.
