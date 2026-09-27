# Agent Connector v0.1.4

Agent Connector is now independently installable from JSR and resolves `agent` through `PATH`. It no longer bundles,
installs, or manages Portable Agents. The standalone archives contain `agc`, deployment examples, licenses, and notices;
they contain neither `agent` nor Lua.

The private Discord package is embedded in `agc` and materialized idempotently in the user's application-data directory
when a Discord-enabled policy is checked or run. Agent Connector does not install or manage Zinc or any other agent
package.

## Install

Install the JSR CLI:

```sh
deno install --global --name agc \
  --allow-env --allow-ffi --allow-net --allow-read --allow-run=agent --allow-write \
  jsr:@darkhorseprojects/agent-connector@^0.1.4
```

Or download a standalone archive:

| Platform            | Asset                                         |
| ------------------- | --------------------------------------------- |
| Linux x86-64        | `agent-connector-v0.1.4-linux-x86_64.tar.gz`  |
| Linux ARM64         | `agent-connector-v0.1.4-linux-aarch64.tar.gz` |
| macOS Intel         | `agent-connector-v0.1.4-macos-x86_64.tar.gz`  |
| macOS Apple Silicon | `agent-connector-v0.1.4-macos-aarch64.tar.gz` |
| Windows x86-64      | `agent-connector-v0.1.4-windows-x86_64.zip`   |
| Windows ARM64       | `agent-connector-v0.1.4-windows-aarch64.zip`  |

Install Portable Agents independently. Its `agent` executable must be on `PATH`, and its compatible Lua 5.5 shared
library must be visible to the operating system's dynamic loader. Agent processes inherit Connector's environment
unchanged; Connector does not filter, clear, rewrite, discover, or configure environment variables or Lua.

Verify downloads against `SHA256SUMS`. The [wiki](https://github.com/darkhorseprojects/agent-connector/wiki) covers
policy configuration, routing, Discord permissions, and deployment.
