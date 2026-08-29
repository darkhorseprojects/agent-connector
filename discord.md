# Discord

## Guide

`require("discord")` returns the Discord capability for this invocation. `discord.context` contains the actor, policy,
user, message, channel, and optional parent channel and guild identifiers. `discord.request(method, route, options)`
calls a Discord REST route. Options may contain `query`, `body`, `reason`, and base64-encoded `files`.

Use context identifiers unless the request explicitly names another target. The capability can use any REST route
allowed by the bot while the invocation is active.

## Program

```lua
local json = require("lunajson")
local endpoint = assert(os.getenv("AGENT_CONNECTOR_DISCORD_URL"), "Discord RPC URL is unavailable")
local token = assert(os.getenv("AGENT_CONNECTOR_DISCORD_TOKEN"), "Discord RPC token is unavailable")
local maximum = assert(tonumber(os.getenv("AGENT_CONNECTOR_FRAME_BYTES")), "Discord RPC limit is unavailable")
local context_source = assert(os.getenv("AGENT_CONNECTOR_DISCORD_CONTEXT"), "Discord context is unavailable")
local context = json.decode(context_source)
local origin = assert(endpoint:match("^([%a][%w+.-]*://[^/%?#]+)"), "Discord RPC origin is invalid")
local http = require("pa.host")({
    limits = { http_request_bytes = maximum, http_response_bytes = maximum, concurrent_operations = 1 },
    http = { { origin = origin } },
}, document.Discord.Guide).http

local function request(method, route, options)
    local value = { method = method, route = route }
    for key, item in pairs(options or {}) do value[key] = item end
    local iterator = http({
        url = endpoint .. "/v1/request",
        method = "POST",
        body = json.encode(value),
        headers = { authorization = "Bearer " .. token, ["content-type"] = "application/json", accept = "application/json" },
    })
    local chunks, response, event = {}, nil, iterator()
    while event do
        if type(event) == "function" then
            event = iterator(coroutine.yield(event))
        else
            if event.type == "data" then chunks[#chunks + 1] = event.data else response = event end
            event = iterator()
        end
    end
    local result = json.decode(table.concat(chunks))
    if not response or response.status < 200 or response.status >= 300 then
        error(type(result) == "table" and tostring(result.error or "Discord RPC failed") or "Discord RPC failed")
    end
    return result
end

return { guide = document.Discord.Guide, context = context, request = request }
```
