import { NexxusRedis } from '../Redis';
import { NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';

import { randomBytes } from 'node:crypto';

/**
 * Single-use, app-scoped, expiring nonces at `nxx:auth-nonce:{appId}:{nonce}`.
 *
 * Deliberately generic — nothing here knows about OAuth. Its first consumer is
 * the OAuth `state` parameter (see `NexxusAuthStrategy.signState`), but the same
 * primitive covers anything that needs a one-shot token with a deadline: magic
 * links, password-reset links, device pairing codes.
 *
 * Two properties matter, and both come from Redis rather than from the caller:
 *
 *   - **Single use.** `consume` is a `GETDEL`, so the read and the delete are
 *     one atomic command. Two concurrent consumers of the same nonce cannot
 *     both succeed, which is what makes it a replay defence rather than just
 *     a lookup.
 *   - **Expiry.** The TTL is set with the value in the same `SET`, so a nonce
 *     that is never consumed cannot linger.
 *
 * The value is an opaque string the issuer chooses. Callers that only need
 * proof-of-issuance can leave it at the default; callers with a small amount of
 * state to park alongside the nonce can pass their own (JSON-encode it
 * yourself if it isn't already a string).
 *
 * Keys are app-scoped so a nonce minted for one application can never be
 * consumed under another — the appId is part of the key, not just the value.
 */
export class NexxusAuthNonce {
  /** Long enough for an OAuth round trip, short enough to bound a leaked nonce. */
  private static readonly DEFAULT_TTL_SECONDS = 300;
  private static readonly NONCE_BYTES = 32;

  /**
   * Nonces this class issues are base64url. Anything else came from somewhere
   * else — reject it before it reaches Redis rather than letting a caller-
   * supplied string shape the key.
   */
  private static readonly NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

  public static getKey(appId: string, nonce: string): string {
    return `${NEXXUS_PREFIX_LC}:auth-nonce:${appId}:${nonce}`;
  }

  /**
   * Mint a nonce for `appId` and store `value` under it. Returns the nonce for
   * the caller to hand to whoever will present it back.
   */
  public static async issue(
    appId: string,
    value: string = '1',
    ttlSeconds: number = NexxusAuthNonce.DEFAULT_TTL_SECONDS
  ): Promise<string> {
    const nonce = randomBytes(NexxusAuthNonce.NONCE_BYTES).toString('base64url');

    await NexxusRedis.instance.getClient().set(NexxusAuthNonce.getKey(appId, nonce), value, {
      expiration: { type: 'EX', value: ttlSeconds },
    });

    return nonce;
  }

  /**
   * Redeem a nonce, returning the stored value — or `null` if it never
   * existed, has expired, has already been redeemed, or isn't a well-formed
   * nonce. Callers should treat every `null` the same way: reject.
   */
  public static async consume(appId: string, nonce: string): Promise<string | null> {
    if (typeof nonce !== 'string' || !NexxusAuthNonce.NONCE_PATTERN.test(nonce)) {
      return null;
    }

    const value = await NexxusRedis.instance.getClient().getDel(NexxusAuthNonce.getKey(appId, nonce));

    return value ?? null;
  }
}
