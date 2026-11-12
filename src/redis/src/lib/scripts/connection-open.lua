-- Open a connection on a device: add its entry under `$.connections` and record
-- `lastSeen`, but only while the device's session is active. The check and the
-- write have to be one step: a logout landing between them would leave an entry
-- on a session that has ended, for a connection the logout never closes.
--
-- An entry already under this id is left as it is, so opening again is safe.
--
-- KEYS[1]  the device
-- ARGV[1]  the entry's JSON path, `$.connections['<id>']`
-- ARGV[2]  the entry, as JSON
-- ARGV[3]  the time now, in UNIX seconds
-- ARGV[4]  the `lastSeen` to record, as a JSON string
--
-- Returns 1 when the connection is open, 0 when the session has ended or
-- expired, -1 when the device does not exist.

local raw = redis.call('JSON.GET', KEYS[1], '$.session.expiresAt')

if not raw then
  return -1
end

-- A `$` path reads every match: an empty list when there is no session.
local expiresAt = cjson.decode(raw)[1]

if expiresAt == nil or tonumber(expiresAt) <= tonumber(ARGV[3]) then
  return 0
end

-- A device that has never had a connection has no map to add to.
redis.call('JSON.SET', KEYS[1], '$.connections', '{}', 'NX')
redis.call('JSON.SET', KEYS[1], ARGV[1], ARGV[2], 'NX')
redis.call('JSON.SET', KEYS[1], '$.lastSeen', ARGV[4])

return 1
