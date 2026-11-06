-- Replace a device's session, but only while its hash is still the one the
-- caller read, so two refreshes racing on the same secret can't both rotate it.
--
-- The caller decides whether to rotate, from the session it read; this script
-- only makes the write conditional. Keeping it that small keeps the decision in
-- TypeScript, where it is unit-tested.
--
-- KEYS[1]  the device
-- ARGV[1]  the session hash the caller read
-- ARGV[2]  the new session, as JSON
--
-- Returns 1 when the session was replaced, 0 when the stored hash differs or
-- there is no session, -1 when the device does not exist.

local raw = redis.call('JSON.GET', KEYS[1], '$.session.hash')

if not raw then
  return -1
end

-- A `$` path reads every match: an empty list when there is no session.
local hash = cjson.decode(raw)[1]

if hash ~= ARGV[1] then
  return 0
end

redis.call('JSON.SET', KEYS[1], '$.session', ARGV[2])

return 1
