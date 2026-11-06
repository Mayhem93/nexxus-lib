-- Delete a username lock, but only while it still holds the caller's token, so
-- a holder whose lock already expired can't release the next holder's.
--
-- KEYS[1]  the lock
-- ARGV[1]  the caller's token
--
-- Returns 1 when the lock was deleted, 0 when it holds another token or is gone.

if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end

return 0
