-- Take a channel off a connection's entry. Finding it and removing it are one
-- step, so another change to the list can't shift it in between.
--
-- KEYS[1]  the device
-- ARGV[1]  the entry's JSON path, `$.connections['<id>']`
-- ARGV[2]  the channel key, as a JSON string
--
-- Returns 1 when the channel was listed and is removed, 0 when it wasn't
-- listed, -2 when the connection doesn't exist, -1 when the device does not
-- exist.

local path = ARGV[1] .. '.subscriptions'
local raw = redis.call('JSON.GET', KEYS[1], path)

if not raw then
  return -1
end

-- A `$` path reads every match: an empty list when there is no such entry.
local listed = cjson.decode(raw)[1]

if listed == nil then
  return -2
end

local channel = cjson.decode(ARGV[2])

for i, key in ipairs(listed) do
  if key == channel then
    -- JSON arrays count from 0, Lua tables from 1.
    redis.call('JSON.ARRPOP', KEYS[1], path, i - 1)

    return 1
  end
end

return 0
