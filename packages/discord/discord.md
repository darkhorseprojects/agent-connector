# Discord

```lua
local json = require("lunajson")
local pa = require("pa")

local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function base64(bytes)
    local output = {}
    for offset = 1, #bytes, 3 do
        local first, second, third = bytes:byte(offset, offset + 2)
        local value = first * 65536 + (second or 0) * 256 + (third or 0)
        output[#output + 1] = alphabet:sub((value >> 18 & 63) + 1, (value >> 18 & 63) + 1)
        output[#output + 1] = alphabet:sub((value >> 12 & 63) + 1, (value >> 12 & 63) + 1)
        output[#output + 1] = second and alphabet:sub((value >> 6 & 63) + 1, (value >> 6 & 63) + 1) or "="
        output[#output + 1] = third and alphabet:sub((value & 63) + 1, (value & 63) + 1) or "="
    end
    return table.concat(output)
end

local function request(value, config)
    assert(type(config) == "string", "invalid Discord config")
    local separator = assert(config:find("\0", 1, true), "invalid Discord config")
    local origin, token = config:sub(1, separator - 1), config:sub(separator + 1)
    assert(origin ~= "" and token ~= "" and not token:find("\0", 1, true), "invalid Discord config")
    local status, body = pa.http(origin, "POST", "/v1/request", json.encode(value), {
        authorization = "Bearer " .. token,
        ["content-type"] = "application/json",
        accept = "application/json",
    })
    assert(status >= 200 and status < 300, body)
    return json.decode(body)
end

local entry = {}

function entry.document()
    return [[local discord = require("discord")
discord.context() -> {policy,memberId,channelId,messageId?,messageChannelId?,parentChannelId?,guildId?}
discord.list_messages(limit?,before?) -> messages
discord.get_message(message_id) -> message
discord.create_message(content?,filename?,bytes?,content_type?) -> message_id
discord.edit_message(message_id,content) -> true
discord.delete_message(message_id) -> true
discord.add_reaction(message_id,emoji) -> true
discord.remove_reaction(message_id,emoji) -> true
Messages and context are Lua tables; IDs and emoji are strings. An attachment uses one filename and raw byte string.]]
end

function entry.context(config)
    return request({ type = "context" }, config)
end

function entry.list_messages(config, limit, before)
    return request({ type = "listMessages", limit = limit, before = before }, config)
end

function entry.get_message(config, message)
    return request({ type = "getMessage", message = message }, config)
end

function entry.create_message(config, content, filename, bytes, content_type)
    local value = { type = "createMessage", content = content }
    if filename ~= nil or bytes ~= nil or content_type ~= nil then
        assert(type(filename) == "string" and type(bytes) == "string", "invalid attachment")
        value.files = { { name = filename, data = base64(bytes), contentType = content_type } }
    end
    return request(value, config).id
end

function entry.edit_message(config, message, content)
    return request({ type = "editMessage", message = message, content = content }, config)
end

function entry.delete_message(config, message)
    return request({ type = "deleteMessage", message = message }, config)
end

function entry.add_reaction(config, message, emoji)
    return request({ type = "addReaction", message = message, emoji = emoji }, config)
end

function entry.remove_reaction(config, message, emoji)
    return request({ type = "removeReaction", message = message, emoji = emoji }, config)
end

return setmetatable(entry, {
    __call = function()
        error("use Discord module members", 0)
    end,
    __metatable = false,
})
```
