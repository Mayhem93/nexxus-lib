import { NexxusRedis } from '../Redis';
import { NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';

import { randomUUID } from 'node:crypto';

/**
 * Delete the lock only while it still holds the caller's token, so a holder
 * whose lock already expired can't release the next holder's. Touches one key,
 * passed as KEYS[1], so it is single-slot and runs unchanged on a cluster.
 */
export const NEXXUS_USERNAME_LOCK_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * A short lock on one username of one application, at
 * `nxx:username_lock:{appId}:{username}`.
 *
 * The database can't enforce a unique username, so creating an account is "look
 * the username up, then insert it" — and two requests doing that at once would
 * both insert. Held around those two steps, the lock makes them take turns: two
 * registrations, or a registration and a first OAuth sign-in, for the same
 * username.
 *
 * It expires on its own, so a process that dies holding it blocks nobody for
 * long.
 */
export class NexxusUsernameLock {
  /** How long the lock lives if its holder never releases it. */
  private static readonly TTL_MS = 10000;
  /** How long a caller waits for the holder before giving up. */
  private static readonly DEFAULT_WAIT_MS = 3000;
  /** How often a waiting caller tries again. */
  private static readonly RETRY_MS = 100;

  private constructor(private readonly key: string, private readonly token: string) {}

  public static getKey(appId: string, username: string): string {
    return `${NEXXUS_PREFIX_LC}:username_lock:${appId}:${username}`;
  }

  /**
   * Take the lock, waiting up to `waitMs` for its current holder to release it.
   * `null` when it's still held after that.
   */
  public static async acquire(
    appId: string,
    username: string,
    waitMs: number = NexxusUsernameLock.DEFAULT_WAIT_MS
  ): Promise<NexxusUsernameLock | null> {
    const key = NexxusUsernameLock.getKey(appId, username);
    const token = randomUUID();
    const deadline = Date.now() + waitMs;

    do {
      const taken = await NexxusRedis.instance.getClient().set(key, token, {
        condition: 'NX',
        expiration: { type: 'PX', value: NexxusUsernameLock.TTL_MS }
      });

      if (taken === 'OK') {
        return new NexxusUsernameLock(key, token);
      }

      await new Promise(resolve => setTimeout(resolve, NexxusUsernameLock.RETRY_MS));
    } while (Date.now() < deadline);

    return null;
  }

  /** Release the lock, unless it has expired and someone else holds it now. */
  public async release(): Promise<void> {
    await NexxusRedis.instance.getClient().eval(NEXXUS_USERNAME_LOCK_RELEASE_SCRIPT, {
      keys: [ this.key ],
      arguments: [ this.token ]
    });
  }
}
