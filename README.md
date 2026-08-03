# Agent Connector

Agent Connector routes Discord messages to an explicit [Portable Agents](https://github.com/darkhorseprojects/portable-agents) package. It authenticates Discord, selects a configured execution policy, and starts one `agent run` process per request. It does not embed Portable Agents or interpret an Agent's Markdown, Lua, memory, tools, or provider configuration.

Discord integration uses [Serenity](https://github.com/serenity-rs/serenity).

## Build

```sh
cargo build --locked --release
install target/release/agc ~/.local/bin/agc
```

`agent` must be available on `PATH`.

## Configure

Create `agent-connector.yaml` in the Agent package directory:

```yaml
version: 1

discord:
  application: "123456789012345678"
  bot: "234567890123456789"

policies:
  zinc:
    entry: zinc.md
    authority:
      - src/store.lua
      - src/memory.lua
      - src/sglang.lua
      - src/env.lua
    directory: /absolute/workspace
    memory: 96MiB
    timeout: 30s

users:
  "123456789012345678": zinc

channels:
  "234567890123456789": zinc

guilds:
  "345678901234567890": zinc
```

The Agent package is the directory containing this file. Entries and authority paths are relative to that package. `directory` is the working directory for the selected policy and must be absolute.

Configuration is strict: unknown and duplicate fields, aliases, anchors, tags, merge keys, numeric IDs, escaping paths, and references to absent policies fail.

## Discord application

Create a bot in the Discord developer portal. Enable the `GUILDS`, `GUILD_MESSAGES`, and `DIRECT_MESSAGES` gateway intents. The privileged Message Content intent is not required: Discord supplies content for direct messages and guild messages that mention the bot.

Connect the credential:

```sh
agc connect /path/to/agent
```

The command prompts without echo, validates the bot and application IDs, stores the token privately, and prints the bot installation URL. The requested permissions are View Channels, Send Messages, and Send Messages in Threads. Agent Connector registers no slash commands.

Credentials are stored by the SHA-256 identity of the canonical Agent directory:

```text
Linux/macOS  ~/.agents/credentials/<identity>.discord-token
Windows      %LOCALAPPDATA%\Agent Connector\credentials\<identity>.discord-token
```

Unix directories use mode `0700` and token files use `0600`. Windows ACLs grant the current user and `SYSTEM`. Tokens are never stored in YAML, logs, Agent arguments, or the Agent environment.

## Operate

```sh
agc check /path/to/agent
agc run /path/to/agent
agc up /path/to/agent
agc down /path/to/agent
agc auto on /path/to/agent
agc auto off /path/to/agent
agc /path/to/agent
```

`DIRECTORY` may be omitted only when the current directory itself contains `agent-connector.yaml`. Parent directories are not searched.

DMs route by author ID. Guild messages must mention the bot; exact channel routing wins over guild routing. The mention token is removed without trimming or normalizing the remaining content. Bot and webhook messages are ignored.

At most four Agent processes run concurrently and 32 requests wait in FIFO order. A full queue receives `Agent Connector is busy.` Each successful Agent result must be nonempty UTF-8 valid as one Discord message. It is sent unchanged with Discord mention parsing disabled.

## Invocation

A request from Discord user `998877` under the sample policy becomes:

```sh
agent run \
  --directory /path/to/agent \
  --entry zinc.md \
  --authority src/store.lua \
  --authority src/memory.lua \
  --authority src/sglang.lua \
  --authority src/env.lua \
  --memory 96MiB \
  --timeout 30s \
  -- 998877
```

The exact request is provided on stdin. Agent Connector drains bounded stdout and stderr concurrently and owns the complete process group or Windows Job Object. Timeout and overflow terminate all descendants.

## Lifecycle

`agc run` is the foreground service. `up` starts it detached and waits for Discord readiness. `down` uses an authenticated owner-private Unix socket or Windows named pipe; it does not kill a PID read from a file.

Autostart uses:

- systemd user services on Linux;
- LaunchAgents on macOS;
- Task Scheduler on Windows.

The service executes `agc run` with the canonical Agent directory. Service definitions contain no credential.

## Validate

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
```

## License

Apache-2.0
