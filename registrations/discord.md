# Discord

## Guide

Use `require("discord")` for Discord operations scoped to the active Connector invocation.

`discord.context` contains `actor`, `policy`, `userId`, `messageId`, `channelId`, and optional `parentChannelId` and
`guildId`.

`discord.request(method, route, options)` calls a Discord REST route. Options may contain `query`, `body`, `reason`, and
base64-encoded `files`.

`discord.messages` provides `history`, `get`, `send`, `edit`, and `delete`. `discord.reactions` provides `add`,
`remove`, and `users`. `discord.dms` provides `open` and `send`. `discord.channels.typing(channel)` sends a typing
event.

Use IDs from `discord.context` unless the request explicitly requires another target. Discord permissions remain
authoritative.

## Program

```lua
local curl = require("cURL.safe")
local json = require("dkjson")

local function encode(value)
    return assert(json.encode(value))
end

local function decode(source)
    local value, position, failure = json.decode(source, 1, json.null)
    assert(not failure and not source:sub(position):find("%S"), failure or "Discord RPC returned trailing data")
    return value
end

local function transport(method, path, value)
    local endpoint = assert(os.getenv("AGENT_CONNECTOR_DISCORD_URL"), "Discord RPC URL is unavailable")
    local token = assert(os.getenv("AGENT_CONNECTOR_DISCORD_TOKEN"), "Discord RPC token is unavailable")
    local chunks = {}
    local handle = assert(curl.easy({
        url = endpoint .. path,
        customrequest = method,
        postfields = value == nil and nil or encode(value),
        httpheader = {
            "authorization: Bearer " .. token,
            "content-type: application/json",
            "accept: application/json",
        },
        followlocation = false,
        writefunction = function(chunk)
            chunks[#chunks + 1] = chunk
            return #chunk
        end,
    }))
    local ok, failure = handle:perform()
    local status = handle:getinfo_response_code()
    handle:close()
    assert(ok, failure)
    local response = decode(table.concat(chunks))
    if status < 200 or status >= 300 then
        error(type(response) == "table" and tostring(response.error or "Discord RPC failed") or "Discord RPC failed")
    end
    return response
end

local function segment(value)
    assert(type(value) == "string" and value ~= "", "Discord route value must be nonempty text")
    return (value:gsub("([^%w%-._~])", function(byte)
        return string.format("%%%02X", string.byte(byte))
    end))
end

local function body(value)
    return type(value) == "string" and { content = value } or value
end

local discord = { guide = document.Discord.Guide, context = transport("GET", "/v1/context") }

function discord.request(method, route, options)
    local request = { method = method, route = route }
    for key, value in pairs(options or {}) do request[key] = value end
    return transport("POST", "/v1/request", request).value
end

discord.messages = {}
function discord.messages.history(channel, query)
    return discord.request("GET", "/channels/" .. segment(channel) .. "/messages", { query = query })
end
function discord.messages.get(channel, message)
    return discord.request("GET", "/channels/" .. segment(channel) .. "/messages/" .. segment(message))
end
function discord.messages.send(channel, value)
    return discord.request("POST", "/channels/" .. segment(channel) .. "/messages", { body = body(value) })
end
function discord.messages.edit(channel, message, value)
    return discord.request("PATCH", "/channels/" .. segment(channel) .. "/messages/" .. segment(message), { body = body(value) })
end
function discord.messages.delete(channel, message, reason)
    return discord.request("DELETE", "/channels/" .. segment(channel) .. "/messages/" .. segment(message), { reason = reason })
end

discord.reactions = {}
function discord.reactions.add(channel, message, emoji)
    return discord.request("PUT", "/channels/" .. segment(channel) .. "/messages/" .. segment(message) .. "/reactions/" .. segment(emoji) .. "/@me")
end
function discord.reactions.remove(channel, message, emoji, user)
    return discord.request("DELETE", "/channels/" .. segment(channel) .. "/messages/" .. segment(message) .. "/reactions/" .. segment(emoji) .. "/" .. (user and segment(user) or "@me"))
end
function discord.reactions.users(channel, message, emoji, query)
    return discord.request("GET", "/channels/" .. segment(channel) .. "/messages/" .. segment(message) .. "/reactions/" .. segment(emoji), { query = query })
end

discord.dms = {}
function discord.dms.open(user)
    return discord.request("POST", "/users/@me/channels", { body = { recipient_id = user } })
end
function discord.dms.send(user, value)
    return discord.messages.send(assert(discord.dms.open(user).id), value)
end

discord.channels = {}
function discord.channels.typing(channel)
    return discord.request("POST", "/channels/" .. segment(channel) .. "/typing")
end

return discord
```
