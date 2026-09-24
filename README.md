# Agent Connector

Agent Connector routes Discord messages to Portable Agents policies. It passes text as UTF-8 input, applies a one-call
overlay to the policy's opaque JSON config, supplies configured PA Imports, and delivers completed assistant turns as
Discord Markdown. Image attachments are passed in a bounded envelope for image-capable agents such as Zinc.

## Install

Install `agc`, `agent`, and the included Lua 5.5 shared library into the same executable directory. PA locates that
library through a platform-relative loader path. Install `dist/packages` into the per-user application-data directory:

```text
Linux:  ${XDG_DATA_HOME:-$HOME/.local/share}/agent-connector/packages
macOS:  $HOME/Library/Application Support/Agent Connector/packages
Windows: %LOCALAPPDATA%\Agent Connector\packages
```

Standalone Connector does not load packages beside its executable.

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
    instructions: 200000000
    discord: true
    images: true
    imports: {}
    overrides: [parent, memory, run, models, retrieval]
    config:
      version: 1
      actor: "discord:${application}:${policy}:member:${member}:channel:${channel}"
      preset: safe
members: {}
channels: {}
guilds: {}
```

`directory` is optional and defaults to the directory containing `ac.yaml`; `source` is relative to it. PA owns Lua
dependency discovery. Connector passes the platform home directory (and Windows `SystemRoot`) to its exact Agent child
environment; users do not set Lua loader variables.

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

The edge config recursively overlays the imported policy's config. `images: true` opts a policy into image envelopes;
text-only policies retain raw UTF-8 input. `discord: true` separately supplies the built-in Import named `discord`; it
does not modify the agent's opaque config. An agent can inspect its PA grants with `pa.imports()`.

## Routing

Configured channel or thread-parent routes take precedence, followed by member routes, then guild routes. DMs require a
member route. Configured channels receive ordinary messages directly; member and guild routes in a guild require a bot
mention. Empty maps deny access. Accepted message requests show typing in their destination channel while actively
running. Queued requests do not send periodic typing requests. Slash commands use their deferred reply instead. Ordinary
messages may include text and image attachments, or images alone in an already-routed channel; mention-routed guild
messages still require a bot mention. PNG, JPEG, and WebP attachments are limited to four files and 4 MiB total. Images
are not retained for follow-up turns, so reattach them when needed.

A newer request interrupts the same policy/member/channel request. Global concurrency and pending-request limits apply
across message and command invocations. Absent operational settings default to concurrency 4, pending requests 32, a
ten-minute lifetime, an 8 MiB loopback RPC limit, and 32 output messages. Set top-level `profiling: true` in `ac.yaml`
to collect bounded, metadata-only request profiles; it is off by default and is not an Agent config override.

## Per-call config

The registered command accepts a prompt, an optional image, and an optional YAML object; either prompt or image is
required:

```text
/agent prompt:"Investigate this" config:"run: {quota_tokens: 12000}"
```

`overrides` explicitly grants caller control of the listed top-level config fields; absent fields are denied. Connector
rejects any other caller key before recursively overlaying the object. Objects merge; arrays, scalars, and `null`
replace. Trusted policy values such as the interpolated actor and selected preset remain sealed unless the operator
explicitly grants those fields. Connector does not interpret the agent's config schema. The selected Agent owns
validation and resource ceilings; the override is not persisted and never modifies `ac.yaml`.

## Output

Connector buffers `pa.emit(bytes, "append")` fragments and complete `pa.emit(bytes)` output. Zinc signals each finished
assistant model turn with an empty emission. Connector then sends that turn as new messages, even if the Agent continues
through tools and later turns; it does not edit provisional text. Tool output is included with the next completed turn.
Long output splits at paragraph, line, or word boundaries (or within an unbroken run), reopening code fences where
needed. Mentions stay disabled; exceeding `output_messages` fails explicitly. The terminal result adds only the footer
when its answer was already delivered.

Each request gets a correlation ID before execution. Bounded metadata-only JSONL diagnostics (stage, elapsed time, error
code; no prompts or tokens) are stored with mode `0600` under
`${XDG_STATE_HOME:-$HOME/.local/state}/agent-connector/requests.jsonl` on Linux,
`$HOME/Library/Logs/agent-connector/requests.jsonl` on macOS, or `%LOCALAPPDATA%\\agent-connector\\requests.jsonl` on
Windows. The file rotates at 8 MiB and retains one previous file. Discord sees only the incident ID, never a Lua
traceback. When profiling is enabled, one additional JSONL record per request contains
gateway-to-ready/active/first-send offsets, bounded child stage observations, and partial timings on failure or
interruption. `deno run --allow-read tools/profile_requests.ts PATH/requests.jsonl` summarizes these records. Child
`atUs` values share only the PA child's clock; they are not directly comparable to Connector offsets.

Agents invoked through final-only `Agent.call` can use `pa.emit` safely because it is a no-op when emissions are
disabled.

## Discord Import

`packages/discord/discord.md` is an optional PA Import that proxies scoped Discord operations for Lua. Its loopback
grant permits reads in the selected channel, creation of messages, edits/deletes of grant-created messages, reactions to
any explicit message ID in that channel (plus the triggering message in its original channel), and bounded attachments.
Discord validates channel-scoped reaction targets; the grant does not authorize other channels. Revocation prevents new
calls.

PA exposes native Import members via `require`. Zinc reads each Import's `document()` member when building the model
prompt:

```lua
local discord = require("discord")
local id = discord.create_message("hello")
return id
```

Other members include `context()`, `list_messages(limit?, before?)`, `get_message(id)`, `edit_message(id, content)`,
`delete_message(id)`, and reactions. Lists default to 20 (maximum 50) compact summaries with at most 300 content
characters each; use `get_message(id)` for a full message. `create_message(content?, filename?, bytes?, content_type?)`
accepts one attachment using raw bytes. JSON exists only inside the scoped loopback RPC transport.

## Development

Connector uses the sibling `../portable-agents` workspace package and binary.

```sh
cd ../portable-agents
zig build -Doptimize=ReleaseSafe -Dsystem-lua=true
cd ../agent-connector
deno task check
deno task compile
```

Standalone compilation embeds the native keyring addon and requires FFI permission. PA and package native modules
require ABI-compatible dynamic Lua 5.5; PA resolves package modules without Lua search-path environment variables.

License: AGPL-3.0-only.
