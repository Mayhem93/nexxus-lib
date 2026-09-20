import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NexxusAuthNonce } from '@mayhem93/nexxus-redis';
import { NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';
import { installFakeRedis } from './helpers';
import type { FakeRedis } from './fakeRedis';

let redis: FakeRedis;

/**
 * Installed per DESCRIBE, not at module level: every suite's root-level
 * `beforeEach` runs before every test in the file, so a module-level install
 * here would be overwritten by whichever suite is imported after this one.
 */
const useFakeRedis = () => beforeEach(() => { redis = installFakeRedis(); });

/** The raw entry behind a nonce, so tests can see the stored value and its TTL. */
const entry = (appId: string, nonce: string) =>
  redis.store.get(NexxusAuthNonce.getKey(appId, nonce)) as { value: string; ttl?: number } | undefined;

describe('NexxusAuthNonce.getKey', () => {
  it('scopes the key to the application', () => {
    expect(NexxusAuthNonce.getKey('app1', 'abc')).toBe(`${NEXXUS_PREFIX_LC}:auth-nonce:app1:abc`);
  });
});

describe('NexxusAuthNonce.issue', () => {
  useFakeRedis();

  it('stores a value under a fresh nonce with a default TTL', async () => {
    const nonce = await NexxusAuthNonce.issue('app1');

    expect(entry('app1', nonce)).toEqual({ type: 'string', value: '1', ttl: 300 });
  });

  it('returns a url-safe nonce with no key-delimiting characters', async () => {
    const nonce = await NexxusAuthNonce.issue('app1');

    // base64url of 32 bytes — safe to interpolate into a colon-delimited key.
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never issues the same nonce twice', async () => {
    const nonces = await Promise.all(Array.from({ length: 25 }, () => NexxusAuthNonce.issue('app1')));

    expect(new Set(nonces).size).toBe(25);
  });

  it('accepts a caller-supplied value and TTL', async () => {
    const nonce = await NexxusAuthNonce.issue('app1', JSON.stringify({ userType: 'admin' }), 60);

    expect(entry('app1', nonce)).toMatchObject({ value: '{"userType":"admin"}', ttl: 60 });
  });

  it('sets the expiry in the same command as the value', async () => {
    const spy = vi.spyOn(redis, 'set');

    await NexxusAuthNonce.issue('app1', 'v', 42);

    // One command, not SET followed by EXPIRE — a crash between the two would
    // otherwise leave a nonce that never expires.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[2]).toEqual({ expiration: { type: 'EX', value: 42 } });

    spy.mockRestore();
  });
});

describe('NexxusAuthNonce.consume', () => {
  useFakeRedis();

  it('returns the stored value', async () => {
    const nonce = await NexxusAuthNonce.issue('app1', 'payload');

    expect(await NexxusAuthNonce.consume('app1', nonce)).toBe('payload');
  });

  it('redeems a nonce exactly once', async () => {
    const nonce = await NexxusAuthNonce.issue('app1', 'payload');

    expect(await NexxusAuthNonce.consume('app1', nonce)).toBe('payload');
    expect(await NexxusAuthNonce.consume('app1', nonce)).toBeNull();
    expect(entry('app1', nonce)).toBeUndefined();
  });

  it('returns null for a nonce that was never issued', async () => {
    expect(await NexxusAuthNonce.consume('app1', 'neverIssued')).toBeNull();
  });

  /**
   * The key carries the appId, so a nonce is bound to the app that minted it —
   * presenting it under another app can't redeem it, even though the random
   * part matches.
   */
  it('will not redeem another application\'s nonce', async () => {
    const nonce = await NexxusAuthNonce.issue('app1', 'payload');

    expect(await NexxusAuthNonce.consume('app2', nonce)).toBeNull();
    expect(await NexxusAuthNonce.consume('app1', nonce)).toBe('payload'); // still intact
  });

  it('rejects a malformed nonce without issuing a redis command', async () => {
    const spy = vi.spyOn(redis, 'getDel');

    for (const bad of [ '', 'has:colon', 'has/slash', 'a'.repeat(129), 'nope*' ]) {
      expect(await NexxusAuthNonce.consume('app1', bad)).toBeNull();
    }

    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('rejects a non-string nonce', async () => {
    expect(await NexxusAuthNonce.consume('app1', undefined as never)).toBeNull();
    expect(await NexxusAuthNonce.consume('app1', { toString: () => 'x' } as never)).toBeNull();
  });

  it('ignores a key of the wrong redis type', async () => {
    // Defensive: a key collision with a non-string entry must read as "absent"
    // rather than throwing or returning something unexpected.
    await redis.hSet(NexxusAuthNonce.getKey('app1', 'collides'), 'f', 'v');

    expect(await NexxusAuthNonce.consume('app1', 'collides')).toBeNull();
  });
});
