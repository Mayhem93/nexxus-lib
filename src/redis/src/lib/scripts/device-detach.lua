-- Mark a device offline, but only while it is still on the transport the caller
-- names: a device that has registered on another transport since belongs to
-- that registration. The check and the write have to be one step, or that
-- registration could land between them and be overwritten.
--
-- KEYS[1]  the device
-- ARGV[1]  the transport
-- ARGV[2]  the `lastSeen` to record, as a JSON string
--
-- Returns 1 when the device was marked offline, 0 when it is on another
-- transport or on none, -1 when the device does not exist.

local raw = redis.call('JSON.GET', KEYS[1], '$.transport')

if not raw then
  return -1
end

-- A `$` path reads every match, as a list.
local transport = cjson.decode(raw)[1]

if transport ~= ARGV[1] then
  return 0
end

redis.call('JSON.SET', KEYS[1], '$.subscriptions', '[]')
redis.call('JSON.SET', KEYS[1], '$.status', '"offline"')
redis.call('JSON.SET', KEYS[1], '$.transport', 'null')
redis.call('JSON.SET', KEYS[1], '$.lastSeen', ARGV[2])

return 1
