-- Mark a device online on a transport, as a volatile connection, but only while
-- its session is active. The check and the write have to be one step: a logout
-- landing between them would leave the device online on a session that has
-- ended, with a connection the logout never closes.
--
-- KEYS[1]  the device
-- ARGV[1]  the transport, as a JSON string
-- ARGV[2]  the time now, in UNIX seconds
-- ARGV[3]  the `lastSeen` to record, as a JSON string
--
-- Returns 1 when the device was marked online, 0 when its session has ended or
-- expired, -1 when the device does not exist.

local raw = redis.call('JSON.GET', KEYS[1], '$.session.expiresAt')

if not raw then
  return -1
end

-- A `$` path reads every match: an empty list when there is no session.
local expiresAt = cjson.decode(raw)[1]

if expiresAt == nil or tonumber(expiresAt) <= tonumber(ARGV[2]) then
  return 0
end

redis.call('JSON.SET', KEYS[1], '$.type', '"volatile"')
redis.call('JSON.SET', KEYS[1], '$.status', '"online"')
redis.call('JSON.SET', KEYS[1], '$.transport', ARGV[1])
redis.call('JSON.SET', KEYS[1], '$.lastSeen', ARGV[3])

return 1
