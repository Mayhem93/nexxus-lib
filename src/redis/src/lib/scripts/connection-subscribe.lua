-- List a channel on a connection's entry, unless the connection is closing or
-- gone. A teardown removes the routes of the channels it finds when it starts,
-- so a channel listed after that would leave its route behind.
--
-- KEYS[1]  the device
-- ARGV[1]  the entry's JSON path, `$.connections['<id>']`
-- ARGV[2]  the channel key, as a JSON string
--
-- Returns the connection's transport when the channel is listed, now or
-- already; -2 when the connection is closing or doesn't exist; -1 when the
-- device does not exist.

local raw = redis.call('JSON.GET', KEYS[1], ARGV[1])

if not raw then
  return -1
end

-- A `$` path reads every match: an empty list when there is no such entry.
local entry = cjson.decode(raw)[1]

if entry == nil or entry.closing then
  return -2
end

local channel = cjson.decode(ARGV[2])

for _, listed in ipairs(entry.subscriptions) do
  if listed == channel then
    return entry.transport
  end
end

redis.call('JSON.ARRAPPEND', KEYS[1], ARGV[1] .. '.subscriptions', ARGV[2])

return entry.transport
