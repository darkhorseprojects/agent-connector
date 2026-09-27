# Agent Connector

Agent Connector (`agc`) is a Discord front end for
[Portable Agents](https://github.com/darkhorseprojects/portable-agents). It routes authorized messages and `/agent`
commands to configured agent policies, passes input and optional images to an agent, and delivers completed turns back
to Discord.

Connector handles routing, credentials, process limits, and Discord delivery. The selected agent owns its behavior and
interprets its own configuration; Connector does not make an agent inherently safe. Review policy grants and package
code before exposing a bot.

See the [Agent Connector wiki](https://github.com/darkhorseprojects/agent-connector/wiki) for policy, routing, and
deployment details.

## Install and connect

Install `agc` and `agent` into the same executable directory. Provide an architecture-compatible Lua 5.5 shared library
discoverable by the operating system's dynamic loader; Connector downloads do not include it. Install the built-in
packages under the per-user application-data directory:

| Platform | Package directory                                               |
| -------- | --------------------------------------------------------------- |
| Linux    | `${XDG_DATA_HOME:-$HOME/.local/share}/agent-connector/packages` |
| macOS    | `$HOME/Library/Application Support/Agent Connector/packages`    |
| Windows  | `%LOCALAPPDATA%\Agent Connector\packages`                       |

Create or edit `ac.yaml`, then register a Discord bot and start Connector:

```sh
agc connect .
agc check .
agc run .
```

`connect` validates the bot token, registers the `/agent` command, and stores credentials in the platform's native
credential store. The token is not written to `ac.yaml` or passed to an Agent process.

## Configure a policy

Policies map named agents to their package, entry point, resource ceilings, Imports, and opaque agent config. Routes map
Discord members, channels, or guilds to policy names. For example:

```yaml
version: 1
policies:
  zinc:
    source: package
    entry: zinc
    memory_bytes: 100663296
    discord: true
    images: true
    overrides: [run, models, retrieval]
    config:
      version: 1
      actor: "discord:${application}:${policy}:member:${member}:channel:${channel}"
      preset: safe
members: {}
channels: {}
guilds: {}
```

The sample demonstrates Zinc's actor-scoped memory and optional Discord Import. Set routes explicitly; empty route maps
deny access. `overrides` grants `/agent` callers permission to change only the listed top-level config fields. Without a
grant, per-call changes are denied. See the [wiki](https://github.com/darkhorseprojects/agent-connector/wiki) for the
complete configuration reference and routing precedence.

## How requests work

- Channel routes take precedence over member and guild routes. Member and guild routes in a server require a bot
  mention; DMs require a member route.
- A newer request interrupts an in-flight request for the same policy, member, and channel. Concurrency and
  pending-request limits apply across messages and commands.
- Image-enabled policies can receive up to four PNG, JPEG, or WebP attachments, with a combined 4 MiB limit. Images are
  not retained for follow-up turns.
- Completed assistant turns are sent as Discord messages; Connector does not publish provisional text. Mentions are
  disabled in agent output.
- Agent child processes inherit Connector's environment unchanged.
- Bounded metadata-only diagnostics are stored locally. Profiling is opt-in.

## Development

Connector builds against the sibling `../portable-agents` workspace and binary:

```sh
cd ../portable-agents
zig build -Doptimize=ReleaseSafe
cd ../agent-connector
deno task check
deno task compile
```

PA and package native modules require the same ABI-compatible system Lua 5.5 runtime. The compiled distribution does not
include Lua; standalone builds also require the native keyring addon.

## Learn more

- [Agent Connector wiki](https://github.com/darkhorseprojects/agent-connector/wiki) — policies, routing, Discord
  behavior, and deployment
- [Portable Agents](https://github.com/darkhorseprojects/portable-agents) — the Lua package runtime used to run agents
- [Zinc](https://github.com/darkhorseprojects/zinc) — a Portable Agents package with durable memory and retrieval

License: [AGPL-3.0-only](LICENSE).
