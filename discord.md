# Discord

## Guide

`require("discord")` returns this invocation's capability and context. `discord.request(value)` accepts `listMessages`, `getMessage`,
`createMessage`, `editMessage`, `deleteMessage`, `addReaction`, and `removeReaction`. Connector fixes routes to the granted channel; edit
and delete require grant-created messages, while reactions also allow the triggering message.

## Program

```lua
local document = require("pa.markdown")()
local json = require("lunajson")
local endpoint = assert(os.getenv("AGENT_CONNECTOR_DISCORD_URL"), "Discord RPC URL is unavailable")
local token = assert(os.getenv("AGENT_CONNECTOR_DISCORD_TOKEN"), "Discord RPC token is unavailable")
local context = json.decode(assert(os.getenv("AGENT_CONNECTOR_DISCORD_CONTEXT"), "Discord context is unavailable"))
local origin = assert(endpoint:match("^([%a][%w+.-]*://[^/%?#]+)"), "Discord RPC origin is invalid"); local limits = { origin = origin, timeout_ms = 30000, request_bytes = 8388608, response_bytes = 8388608 }
local http = require("pa.host").new({ http = { limits } }, table.concat(document.Discord.Guide, "\n\n")).http

local function request(value)
    local response = http({
        url = endpoint .. "/v1/request",
        method = "POST",
        body = json.encode(value),
        headers = { authorization = "Bearer " .. token, ["content-type"] = "application/json", accept = "application/json" },
    })
    local result = json.decode(response.body); if response.status < 200 or response.status >= 300 then error(type(result) == "table" and tostring(result.error or "Discord RPC failed") or "Discord RPC failed") end
    return result
end

return { guide = table.concat(document.Discord.Guide, "\n\n"), context = context, request = request }
```
