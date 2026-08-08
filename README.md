# Agent Connector

Agent Connector routes Discord messages directly to [Portable Agents](https://github.com/darkhorseprojects/portable-agents) packages. It authenticates Discord, selects a configured execution policy, and runs one disposable `agent run` process per request using the native Portable Agents TypeScript SDK.

## Key Features

- **Disposable Execution**: Every incoming request evaluates in a fresh Portable Agents worker with bounded memory and deadlines.
- **Strict Configuration**: Validates `agent-connector.yaml` against schema, ensuring absolute paths, positive integers, and valid policy references.
- **Secure Credentials**: Credentials stored under private per-user directories (`0700`/`0600`) keyed by the SHA-256 identity of the canonical agent directory.
- **Concurrency & FIFO Queue**: Enforces a maximum of 4 concurrent agent processes and a 32-request FIFO queue, replying with `Agent Connector is busy.` when saturated.
- **Message Routing**:
  - Direct Messages route by Discord author ID.
  - Guild messages require mentioning the bot; exact channel routing takes precedence over guild-wide routing.
  - The bot mention token is stripped cleanly without altering or normalizing whitespace.
- **Lifecycle & Daemon Control**: Foreground (`agc run`), detached background daemon (`agc up` / `agc down`), and native service autostart (`agc auto on` / `agc auto off` using systemd or launchd).

## Install & Build

```sh
deno task compile
install bin/agc ~/.local/bin/agc
```

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
      - src/llamacpp.lua
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

- `directory` must be an absolute path representing the working directory for the policy.
- `authority` paths and `entry` are relative to the package directory.
- `memory` supports standard units (`B`, `KiB`, `MiB`, `GiB`, `KB`, `MB`, `GB`).
- `timeout` supports time units (`ms`, `s`, `m`, `h`).

## Connect Discord Credentials

```sh
agc connect /path/to/agent
```

The command prompts for your Discord Bot Token without echo, verifies application and bot IDs against Discord API endpoints, securely writes the credential file, and prints the bot invite URL:

```text
Linux/macOS:  ~/.agents/credentials/<sha256(canonical_path)>.discord-token (mode 0600)
Windows:      %LOCALAPPDATA%\Agent Connector\credentials\<sha256(canonical_path)>.discord-token
```

## Commands

```sh
# Validate configuration and compile package entry points
agc check /path/to/agent

# Start background connector service (or pass -f to run foreground)
agc up /path/to/agent

# Stop running background connector service
agc down /path/to/agent

# Register and enable system autostart service (systemd user unit on Linux, launchd on macOS)
agc auto add /path/to/agent

# Unregister and remove system autostart service
agc auto remove /path/to/agent

# List all registered autostart agent services and their statuses
agc auto list
```

## License

[Apache-2.0](LICENSE)
