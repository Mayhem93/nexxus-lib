-- Take one off a counter in a hash, and delete it, together with the fields
-- that go with it, once it reaches zero. One step, so an increment landing at
-- the same moment is either counted before this, and nothing is deleted, or
-- made after it, on a fresh counter.
--
-- KEYS[1]     the hash
-- ARGV[1]     the counter's field
-- ARGV[2...]  fields deleted along with the counter
--
-- Returns what is left on the counter.

local count = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)

if count <= 0 then
  redis.call('HDEL', KEYS[1], unpack(ARGV))
end

return count
