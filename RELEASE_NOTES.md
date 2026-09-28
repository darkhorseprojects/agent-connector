# Agent Connector v0.1.5

This release is built against Portable Agents SDK 0.1.5. Native CI checks `agent` lookup through `PATH`, inherited
environment, and Discord package installation on all six platforms. The GitHub archives are published and verified
before the JSR package. Connector still does not bundle `agent`, Lua, Zinc, or another agent package.

## Install

Install the JSR CLI:

```sh
deno install --global --name agc \
  --allow-env --allow-ffi --allow-net --allow-read --allow-run=agent --allow-write \
  jsr:@darkhorseprojects/agent-connector@^0.1.5
```

Or download a standalone archive:

| Platform            | Asset                                         |
| ------------------- | --------------------------------------------- |
| Linux x86-64        | `agent-connector-v0.1.5-linux-x86_64.tar.gz`  |
| Linux ARM64         | `agent-connector-v0.1.5-linux-aarch64.tar.gz` |
| macOS Intel         | `agent-connector-v0.1.5-macos-x86_64.tar.gz`  |
| macOS Apple Silicon | `agent-connector-v0.1.5-macos-aarch64.tar.gz` |
| Windows x86-64      | `agent-connector-v0.1.5-windows-x86_64.zip`   |
| Windows ARM64       | `agent-connector-v0.1.5-windows-aarch64.zip`  |

Install Portable Agents independently. Its `agent` executable must be on `PATH`, and its compatible Lua 5.5 shared
library must be visible to the operating system's dynamic loader. Agent processes inherit Connector's environment
unchanged; Connector does not filter, clear, rewrite, discover, or configure environment variables or Lua.

Verify downloads against `SHA256SUMS`. The [wiki](https://github.com/darkhorseprojects/agent-connector/wiki) covers
policy configuration, routing, Discord permissions, and deployment.
