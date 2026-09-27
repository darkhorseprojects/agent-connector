# Agent Connector v0.1.2

First public release of `agc`, a Discord front end for
[Portable Agents](https://github.com/darkhorseprojects/portable-agents). It routes authorized messages and `/agent`
commands to configured agent policies. The selected agent owns its behavior; Connector does not make a package safe by
itself.

## What is included

- `agc connect` validates a Discord bot token, registers the `/agent` command, and stores credentials in the platform's
  native credential store. `agc check` validates configured policies; `agc run` starts the connector.
- Policies control package paths, entry points, resource limits, Imports, and optional per-call overrides. Member,
  channel, and guild routes are explicit; empty route maps deny access. A newer request interrupts an in-flight request
  for the same policy, member, and channel.
- Image-enabled policies accept bounded PNG, JPEG, and WebP attachments. Agent output is sent as completed Discord
  messages with mentions disabled. Diagnostics are bounded and profiling is opt-in.
- Agent processes inherit Connector's environment unchanged, including loader paths and policy-defined variables.
- Each download bundles the platform's `agc` executable, Portable Agents `agent` v0.1.2, built-in package assets,
  packaging examples, licenses, and third-party notices. Lua is not bundled; install a system Lua 5.5 runtime before
  running `agc`.

## Downloads

| Platform            | Asset                                  |
| ------------------- | -------------------------------------- |
| Linux x86-64        | `agent-connector-linux-x86_64.tar.gz`  |
| Linux ARM64         | `agent-connector-linux-aarch64.tar.gz` |
| macOS Intel         | `agent-connector-macos-x86_64.tar.gz`  |
| macOS Apple Silicon | `agent-connector-macos-aarch64.tar.gz` |
| Windows x86-64      | `agent-connector-windows-x86_64.zip`   |
| Windows ARM64       | `agent-connector-windows-aarch64.zip`  |

Install Lua 5.5 through the operating system's package manager and keep `agc` and `agent` together. Install built-in
packages under the per-user application-data directory described in the
[README](https://github.com/darkhorseprojects/agent-connector#install-and-connect), then configure `ac.yaml` with
explicit routes. To verify a download, compare its hash with `SHA256SUMS`. The
[wiki](https://github.com/darkhorseprojects/agent-connector/wiki) covers policy configuration, routing, Discord
permissions, and deployment.
