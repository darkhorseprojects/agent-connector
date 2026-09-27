# Agent Connector

Agent Connector (`agc`) is a Discord front end for
[Portable Agents](https://github.com/darkhorseprojects/portable-agents). It routes authorized messages and `/agent`
commands to configured policies and delivers completed turns to Discord.

Connector handles routing, credentials, process limits, and Discord delivery. The selected agent owns its behavior and
interprets its own configuration; Connector does not make an agent inherently safe. Review policy grants and package
code before exposing a bot.

See the [Agent Connector wiki](https://github.com/darkhorseprojects/agent-connector/wiki) for policy, routing, and
deployment details.

## Install

Install the CLI from JSR:

```sh
deno install --global --name agc \
  --allow-env --allow-ffi --allow-net --allow-read --allow-run=agent --allow-write \
  jsr:@darkhorseprojects/agent-connector@^0.1.4
```

Alternatively, download the standalone archive for your platform from the
[latest release](https://github.com/darkhorseprojects/agent-connector/releases/latest) and place `agc` on `PATH`.

Install Portable Agents separately and make `agent` available on `PATH`. `agent` requires an architecture-compatible Lua
5.5 shared library discoverable by the operating system's dynamic loader. It requests `liblua5.5.so.0` on Linux,
`@rpath/liblua.5.5.dylib` on macOS, and `lua55.dll` on Windows.

Agent Connector archives and the JSR package do not contain `agent`, Lua, or Zinc. `agc` embeds only its private Discord
package and materializes it idempotently in the per-user application-data directory when a Discord-enabled policy is
checked or run. Agent packages such as Zinc are installed independently and selected through policy configuration.

## Connect

Create or edit `ac.yaml`, then register a Discord bot and start Connector:

```sh
agc connect .
agc check .
agc run .
```

`connect` validates the bot token, registers the `/agent` command, and stores credentials in the platform's native
credential store. The token is not written to `ac.yaml` or passed to an Agent process.

## Configure a policy

Policies map named agents to their package, entry point, resource ceilings, imports, and opaque agent config. Routes map
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

The sample demonstrates Zinc's actor-scoped memory and optional Discord import. Set routes explicitly; empty route maps
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
- `agent` is resolved through `PATH`. Agent child processes inherit Connector's environment unchanged.
- Bounded metadata-only diagnostics are stored locally. Profiling is opt-in.

## Development

```sh
deno task check
deno task compile
```

The Portable Agents SDK is resolved from JSR according to `deno.json` and pinned in `deno.lock`. Runtime compatibility
is based on the Portable Agents protocol, package format, capabilities, and Lua 5.5 ABI rather than matching repository
commits or release versions.

## Learn more

- [Agent Connector wiki](https://github.com/darkhorseprojects/agent-connector/wiki) — policies, routing, Discord
  behavior, and deployment
- [Portable Agents](https://github.com/darkhorseprojects/portable-agents) — the package runtime used to run agents
- [Zinc](https://github.com/darkhorseprojects/zinc) — a Portable Agents package with durable memory and retrieval

License: [AGPL-3.0-only](LICENSE).
