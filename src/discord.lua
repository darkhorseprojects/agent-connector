local discord = {}

function discord.format(message)
    if not message then return "" end
    local content = message.content or ""
    if type(content) ~= "string" then content = tostring(content or "") end

    -- Preserve markdown structure
    content = content:gsub("^%s+", ""):gsub("%s+$", "")
    return content
end

function discord.title(request, response)
    if not request or request == "" then return "Agent Conversation" end
    -- Derive a concise title (max 50 chars) from the request
    local clean = request:gsub("[\r\n]+", " "):gsub("^%s+", ""):gsub("%s+$", "")
    -- Strip common prefixes like "can you", "what is", "whats", "tell me about"
    local simplified = clean:gsub("^[Hh]ey,?%s*", ""):gsub("^[Hh]ello,?%s*", ""):gsub("^[Yy]o,?%s*", "")
    simplified = simplified:gsub("^[Ww]hat%s+is%s+in%s+", ""):gsub("^[Ww]hats%s+in%s+", ""):gsub("^[Ww]hat%s+is%s+", "")
    simplified = simplified:gsub("^[Cc]an%s+you%s+", ""):gsub("^[Tt]ell%s+me%s+about%s+", ""):gsub("^[Pp]lease%s+", "")
    if simplified == "" then simplified = clean end

    -- Capitalize first letter
    simplified = simplified:sub(1, 1):upper() .. simplified:sub(2)
    if #simplified > 48 then
        simplified = simplified:sub(1, 45) .. "..."
    end
    return simplified
end

function discord.chunk(text, maxChars)
    maxChars = maxChars or 2000
    if not text or #text <= maxChars then return {text or ""} end

    local chunks, remaining = {}, text
    while #remaining > 0 do
        if #remaining <= maxChars then
            chunks[#chunks + 1] = remaining
            break
        end

        local splitIdx = remaining:sub(1, maxChars):match(".*()\n\n")
        if not splitIdx or splitIdx < maxChars * 0.3 then
            splitIdx = remaining:sub(1, maxChars):match(".*()\n")
        end
        if not splitIdx or splitIdx < maxChars * 0.3 then
            splitIdx = remaining:sub(1, maxChars):match(".*()%s")
        end
        if not splitIdx or splitIdx <= 1 then
            splitIdx = maxChars
        end

        local piece = remaining:sub(1, splitIdx - 1):gsub("^%s+", ""):gsub("%s+$", "")
        if piece ~= "" then chunks[#chunks + 1] = piece end
        remaining = remaining:sub(splitIdx):gsub("^%s+", "")
    end
    return #chunks > 0 and chunks or {text:sub(1, maxChars)}
end

return discord
