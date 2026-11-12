-- Start closing a connection: mark its entry as closing, so no channel can be
-- listed on it from now on, and return the entry with the channels it lists.
-- The caller removes their routes, then deletes the entry.
--
-- An entry already marked is marked again and returned all the same, so two
-- teardowns of one connection both get its channels.
--
-- KEYS[1]  the device
-- ARGV[1]  the entry's JSON path, `$.connections['<id>']`
--
-- Returns the entry as it was before this call, inside a JSON list, or nil
-- when the connection or the device does not exist.

local raw = redis.call('JSON.GET', KEYS[1], ARGV[1])

-- A `$` path reads every match: an empty list when there is no such entry.
if not raw or cjson.decode(raw)[1] == nil then
  return false
end

redis.call('JSON.SET', KEYS[1], ARGV[1] .. '.closing', 'true')

return raw
