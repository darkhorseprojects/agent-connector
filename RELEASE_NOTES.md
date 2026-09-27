# Agent Connector v0.1.3

This release updates the bundled Portable Agents executable to v0.1.3. On macOS, `agent` now requests Lua as
`@rpath/liblua.5.5.dylib` instead of using a package manager's absolute library path. Agent Connector's behavior and
policy format are unchanged.

## Runtime contract

Agent processes inherit Connector's environment unchanged. Connector does not filter, clear, rewrite, discover, or
configure environment variables or Lua. The bundled `agent` requires an architecture-compatible Lua 5.5 shared library
discoverable by the operating system's dynamic loader. It requests `liblua5.5.so.0` on Linux, `@rpath/liblua.5.5.dylib`
on macOS, and `lua55.dll` on Windows.

Each archive contains `agc`, Portable Agents `agent` v0.1.3, built-in package assets, deployment examples, licenses, and
third-party notices. Lua is not bundled.

## Downloads

| Platform            | Asset                                  |
| ------------------- | -------------------------------------- |
| Linux x86-64        | `agent-connector-linux-x86_64.tar.gz`  |
| Linux ARM64         | `agent-connector-linux-aarch64.tar.gz` |
| macOS Intel         | `agent-connector-macos-x86_64.tar.gz`  |
| macOS Apple Silicon | `agent-connector-macos-aarch64.tar.gz` |
| Windows x86-64      | `agent-connector-windows-x86_64.zip`   |
| Windows ARM64       | `agent-connector-windows-aarch64.zip`  |

Keep `agc` and `agent` together, install the built-in packages under the per-user application-data directory described
in the [README](https://github.com/darkhorseprojects/agent-connector#install-and-connect), and configure `ac.yaml` with
explicit routes. Verify downloads against `SHA256SUMS`. The
[wiki](https://github.com/darkhorseprojects/agent-connector/wiki) covers policy configuration, routing, Discord
permissions, and deployment.
