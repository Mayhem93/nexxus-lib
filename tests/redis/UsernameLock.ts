import { describe, it, expect, beforeEach } from 'vitest';
import { NexxusUsernameLock } from '@mayhem93/nexxus-redis';
import { NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';
import { installFakeRedis } from './helpers';
import type { FakeRedis } from './fakeRedis';

let redis: FakeRedis;

/** Installed per DESCRIBE — see AuthNonce.ts for why not at module level. */
const useFakeRedis = () => beforeEach(() => { redis = installFakeRedis(); });

/** The raw entry behind a lock, so tests can see its token and TTL. */
const entry = (appId: string, username: string) =>
  redis.store.get(NexxusUsernameLock.getKey(appId, username)) as { value: string; ttl?: number } | undefined;

describe('NexxusUsernameLock.getKey', () => {
  it('scopes the key to the application and the username', () => {
    expect(NexxusUsernameLock.getKey('app1', 'ann@example.com'))
      .toBe(`${NEXXUS_PREFIX_LC}:username_lock:app1:ann@example.com`);
  });
});

describe('NexxusUsernameLock.acquire', () => {
  useFakeRedis();

  it('takes a free lock, with an expiry so a crashed holder blocks nobody for long', async () => {
    expect(await NexxusUsernameLock.acquire('app1', 'ann')).not.toBeNull();
    expect(entry('app1', 'ann')).toMatchObject({ type: 'string', ttl: 10000 });
  });

  it('gives up, with null, when the holder keeps it past the wait', async () => {
    await NexxusUsernameLock.acquire('app1', 'ann');

    expect(await NexxusUsernameLock.acquire('app1', 'ann', 150)).toBeNull();
  });

  it('waits for the holder to release it, then takes it', async () => {
    const first = (await NexxusUsernameLock.acquire('app1', 'ann'))!;

    setTimeout(() => { void first.release(); }, 50);

    expect(await NexxusUsernameLock.acquire('app1', 'ann', 1000)).not.toBeNull();
  });

  it('locks each username of each application separately', async () => {
    await NexxusUsernameLock.acquire('app1', 'ann');

    expect(await NexxusUsernameLock.acquire('app1', 'bob', 0)).not.toBeNull();
    expect(await NexxusUsernameLock.acquire('app2', 'ann', 0)).not.toBeNull();
  });
});

describe('NexxusUsernameLock.release', () => {
  useFakeRedis();

  it('frees the lock', async () => {
    const lock = (await NexxusUsernameLock.acquire('app1', 'ann'))!;

    await lock.release();

    expect(entry('app1', 'ann')).toBeUndefined();
  });

  /**
   * A holder slower than the lock's expiry must not free the lock the next
   * holder has taken since — the next one would then share it with a third.
   */
  it('leaves alone a lock that expired and was taken by someone else', async () => {
    const late = (await NexxusUsernameLock.acquire('app1', 'ann'))!;

    // The expiry, then the next holder, as Redis would see them.
    redis.store.delete(NexxusUsernameLock.getKey('app1', 'ann'));
    await NexxusUsernameLock.acquire('app1', 'ann', 0);

    const next = entry('app1', 'ann')!.value;

    await late.release();

    expect(entry('app1', 'ann')?.value).toBe(next);
  });
});
