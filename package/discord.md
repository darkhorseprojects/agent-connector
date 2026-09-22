# Discord

```lua
local pa = require("pa")

local entry = {}

return setmetatable(entry, {
    __call = function(_, input, config)
        assert(type(input) == "string" and utf8.len(input), "invalid Discord request")
        assert(type(config) == "string", "invalid Discord config")
        local separator = assert(config:find("\0", 1, true), "invalid Discord config")
        local origin, token = config:sub(1, separator - 1), config:sub(separator + 1)
        assert(origin ~= "" and token ~= "" and not token:find("\0", 1, true), "invalid Discord config")
        local status, body = pa.http(origin, "POST", "/v1/request", input, {
            authorization = "Bearer " .. token,
            ["content-type"] = "application/json",
            accept = "application/json",
        })
        assert(status >= 200 and status < 300, body)
        return body
    end,
    __metatable = false,
})
```
