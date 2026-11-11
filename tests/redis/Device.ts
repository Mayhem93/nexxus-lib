import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NexxusDevice, NexxusRedisSubscription } from '@mayhem93/nexxus-redis';
import { NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';
import { installFakeRedis } from './helpers';
import type { FakeRedis } from './fakeRedis';

let redis: FakeRedis;

beforeEach(() => { redis = installFakeRedis(); });

const makeSub = (modelId = 'r1') => new NexxusRedisSubscription({ appId: 'a', model: 'runs', modelId });

describe('NexxusDevice constructor', () => {
  it('applies defaults and preserves a caller id', () => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: undefined as never });

    expect(d.getValue()).toEqual({ id: 'd1', appId: 'a', name: 'Unnamed Device', userId: undefined, lastSeen: undefined });
  });

  it('generates a uuid id when none is given', () => {
    const d = new NexxusDevice({ appId: 'a', name: 'N' } as never);

    expect(d.getValue().id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('requires an appId', () => {
    expect(() => new NexxusDevice({ appId: undefined as never, id: 'd1', name: 'N' }))
      .toThrow(/appId is required/);
  });

  it('parses a lastSeen string into a Date', () => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', lastSeen: '2020-01-01T00:00:00.000Z' });

    expect(d.getValue().lastSeen).toBeInstanceOf(Date);
  });
});

describe('NexxusDevice getKey / get / save', () => {
  it('builds the device key', () => {
    expect(NexxusDevice.getKey('d1')).toBe(`${NEXXUS_PREFIX_LC}:device:d1`);
    expect(new NexxusDevice({ appId: 'a', id: 'd1', name: 'N' }).getKey()).toBe(`${NEXXUS_PREFIX_LC}:device:d1`);
  });

  it('saves a device with no connections, and reads it back', async () => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'Phone' }).save();

    const loaded = await NexxusDevice.get('d1');

    expect(loaded.getValue()).toMatchObject({ id: 'd1', appId: 'a', name: 'Phone' });
    expect(loaded.getConnections()).toEqual({});
  });

  it('throws when getting a non-existent device', async () => {
    await expect(NexxusDevice.get('ghost')).rejects.toThrow(/not found/);
  });
});

describe('NexxusDevice.exists', () => {
  it('tells which devices exist, with one single-key EXISTS per id', async () => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'N' }).save();

    const exists = vi.spyOn(redis, 'exists');

    expect(await NexxusDevice.exists(['d1', 'ghost'])).toEqual(new Map([['d1', true], ['ghost', false]]));
    // A cluster refuses a single command whose keys live on different nodes.
    expect(exists.mock.calls).toEqual([[NexxusDevice.getKey('d1')], [NexxusDevice.getKey('ghost')]]);
  });
});

describe('NexxusDevice.update', () => {
  beforeEach(async () => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'N' }).save();
  });

  it('updates the name', async () => {
    await NexxusDevice.update('d1', { name: 'Renamed' });

    expect((await NexxusDevice.get('d1')).getValue()).toMatchObject({ name: 'Renamed' });
  });

  it('stores a lastSeen Date as an ISO string, rejecting non-Dates', async () => {
    await NexxusDevice.update('d1', { lastSeen: new Date('2020-01-01T00:00:00.000Z') });

    expect((redis.store.get(NexxusDevice.getKey('d1')) as { value: any }).value.lastSeen).toBe('2020-01-01T00:00:00.000Z');
    await expect(NexxusDevice.update('d1', { lastSeen: 'nope' as never })).rejects.toThrow(/expected Date/);
  });

  it('rejects a non-string name', async () => {
    await expect(NexxusDevice.update('d1', { name: 5 as never })).rejects.toThrow(/expected string/);
  });

  it('rejects a field it does not update', async () => {
    await expect(NexxusDevice.update('d1', { userId: 'u2' } as never)).rejects.toThrow(/Unknown field "userId"/);
  });

  it('is a no-op when every update value is undefined', async () => {
    await NexxusDevice.update('d1', { name: undefined });

    expect((await NexxusDevice.get('d1')).getValue().name).toBe('N');
  });

  it('throws a command error when the target device does not exist', async () => {
    await expect(NexxusDevice.update('ghost', { name: 'x' })).rejects.toThrow(/Failed to update device/);
  });
});

const DAY = 24 * 60 * 60;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const storedSession = (id = 'd1'): any => (redis.store.get(NexxusDevice.getKey(id)) as { value: any } | undefined)?.value.session;

describe('NexxusDevice.save only creates', () => {
  /**
   * save() writes the whole document from `data`, which never carries the
   * session — so an overwrite would silently erase it. It has to refuse instead.
   */
  it('refuses to overwrite an existing device, so it can never erase a session', async () => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: 'N' });

    await d.save();
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);

    await expect(d.save()).rejects.toThrow(/already exists/);
    expect(storedSession()).toBeDefined();
  });
});

describe('NexxusDevice sessions', () => {
  beforeEach(async () => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'N' }).save();
  });

  it('stores a hash of the secret, never the secret itself', async () => {
    await NexxusDevice.setSession('d1', 'the-actual-secret', nowSeconds() + DAY);

    expect(storedSession().hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(redis.store.get(NexxusDevice.getKey('d1')))).not.toContain('the-actual-secret');
  });

  it('keeps the session out of what getValue() returns', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);

    // getValue() is what the device routes send to clients.
    expect((await NexxusDevice.get('d1')).getValue()).not.toHaveProperty('session');
  });

  it('reports an active session from the document get() already read', async () => {
    expect((await NexxusDevice.get('d1')).hasActiveSession()).toBe(false);

    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);
    expect((await NexxusDevice.get('d1')).hasActiveSession()).toBe(true);

    await NexxusDevice.setSession('d1', 's1', nowSeconds() - 1);
    expect((await NexxusDevice.get('d1')).hasActiveSession()).toBe(false);
  });

  it('rotates on the current secret, carrying expiresAt through unchanged', async () => {
    const expiresAt = nowSeconds() + DAY;

    await NexxusDevice.setSession('d1', 's1', expiresAt);

    const firstHash = storedSession().hash;

    expect(await NexxusDevice.rotateSession('d1', 's1', 's2')).toBe('rotated');
    // Absolute: rotating never moves the deadline, or an active device would
    // never have to sign in again.
    expect(storedSession()).toMatchObject({ prevHash: firstHash, expiresAt });
    expect(storedSession().hash).not.toBe(firstHash);
    // The new secret is the one that works now.
    expect(await NexxusDevice.rotateSession('d1', 's2', 's3')).toBe('rotated');
  });

  it('accepts the previous secret within the reuse interval', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);
    await NexxusDevice.rotateSession('d1', 's1', 's2');

    // The response carrying s2 was lost on the way; the client retries with s1.
    expect(await NexxusDevice.rotateSession('d1', 's1', 's3')).toBe('rotated');
  });

  it('treats the previous secret after the reuse interval as a replay and ends the session', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);
    await NexxusDevice.rotateSession('d1', 's1', 's2');
    storedSession().rotatedAt -= 60;

    expect(await NexxusDevice.rotateSession('d1', 's1', 's3')).toBe('replayed');
    expect(storedSession()).toBeUndefined();
    // Whoever held the current secret is out too — the whole chain is ended.
    expect(await NexxusDevice.rotateSession('d1', 's2', 's4')).toBe('invalid');
  });

  /**
   * Device ids are not secret — they sit in the readable token payload and in
   * `/device/list`. If an unmatched secret could change anything, anyone who
   * knows an id could end that device's session.
   */
  it('rejects an unknown secret without touching the session', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);

    const before = { ...storedSession() };

    expect(await NexxusDevice.rotateSession('d1', 'a-guess', 's2')).toBe('invalid');
    expect(storedSession()).toEqual(before);
  });

  it('ends an expired session instead of rotating it', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() - 1);

    expect(await NexxusDevice.rotateSession('d1', 's1', 's2')).toBe('expired');
    expect(storedSession()).toBeUndefined();
  });

  it('rejects rotation on a device that has no session', async () => {
    expect(await NexxusDevice.rotateSession('d1', 's1', 's2')).toBe('invalid');
  });

  it('throws when rotating on a device that does not exist', async () => {
    await expect(NexxusDevice.rotateSession('ghost', 's1', 's2')).rejects.toThrow(/not found/);
  });

  /**
   * Two refreshes racing on one secret: the second one's swap must fail rather
   * than overwrite the first, then decide again on what is stored now.
   */
  it('decides again when another rotation lands between its read and its swap', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);

    redis.beforeEval = () => {
      redis.beforeEval = null;

      const s = storedSession();

      Object.assign(s, { prevHash: s.hash, hash: 'rotated-by-the-other-request', rotatedAt: nowSeconds() });
    };

    expect(await NexxusDevice.rotateSession('d1', 's1', 's2')).toBe('rotated');
    // Swapped on top of the competing rotation, not over it.
    expect(storedSession().prevHash).toBe('rotated-by-the-other-request');
  });

  it('starts a new chain when a session is set again', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);
    await NexxusDevice.rotateSession('d1', 's1', 's2');

    // A sign-in on a reused device issues a fresh session.
    await NexxusDevice.setSession('d1', 'fresh', nowSeconds() + DAY);

    expect(storedSession().prevHash).toBeUndefined();
    expect(await NexxusDevice.rotateSession('d1', 's2', 'x')).toBe('invalid');
  });

  it('fails to start a session on a device that does not exist', async () => {
    await expect(NexxusDevice.setSession('ghost', 's1', nowSeconds() + DAY)).rejects.toThrow(/Failed to start a session/);
  });

  it('revokes on the current secret, and not on an unknown one', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);

    expect(await NexxusDevice.revokeSession('d1', 'a-guess')).toBe('invalid');
    expect(storedSession()).toBeDefined();

    expect(await NexxusDevice.revokeSession('d1', 's1')).toBe('revoked');
    expect(storedSession()).toBeUndefined();
  });

  it('revokes on the previous secret, even past the reuse interval', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);
    await NexxusDevice.rotateSession('d1', 's1', 's2');
    storedSession().rotatedAt -= 60;

    expect(await NexxusDevice.revokeSession('d1', 's1')).toBe('revoked');
    expect(storedSession()).toBeUndefined();
  });

  it('clears a session idempotently, including on a device that does not exist', async () => {
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);

    await NexxusDevice.clearSession('d1');
    await NexxusDevice.clearSession('d1');
    await NexxusDevice.clearSession('ghost');

    expect(storedSession()).toBeUndefined();
  });
});

describe('NexxusDevice connections', () => {
  const SCOPES_KEY = `${NEXXUS_PREFIX_LC}:subscription-scopes:a:runs`;

  const stored = (): any => (redis.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;
  const entry = (connectionId = 'c1'): any => stored().connections?.[connectionId];

  /** How many routes the scope counter of `makeSub(modelId)`'s channel holds; 0 once it is gone. */
  const scopeCount = async (modelId = 'r1'): Promise<number> =>
    Number((await redis.hGetAll(SCOPES_KEY))[`id:${modelId}`] ?? 0);

  const open = (connectionId = 'c1', transport = 'tq'): Promise<boolean> =>
    NexxusDevice.openConnection('d1', connectionId, { transport, type: 'volatile' });

  const subscribe = (connectionId = 'c1', sub = makeSub()): Promise<void> =>
    NexxusDevice.addSubscription('d1', connectionId, sub);

  /** A device with a live session, as signing in leaves it. */
  beforeEach(async () => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'N' }).save();
    await NexxusDevice.setSession('d1', 'secret', nowSeconds() + DAY);
  });

  it('takes the ids transports use as connection ids, and nothing that would break a route or a JSON path', () => {
    for (const id of [ '0f8fad5b-d9cb-469f-a165-70867728950e', 'dXk3:APA91bH-x_y', 'a'.repeat(256) ]) {
      expect(NexxusDevice.isValidConnectionId(id)).toBe(true);
    }

    for (const id of [ '', 'a|b', 'a\'b', 'a\\b', 'a b', 'a.b', 'a'.repeat(257) ]) {
      expect(NexxusDevice.isValidConnectionId(id)).toBe(false);
    }
  });

  describe('openConnection', () => {
    it('adds an entry with no subscriptions, and records lastSeen', async () => {
      expect(await open()).toBe(true);

      expect(entry()).toEqual({ transport: 'tq', type: 'volatile', subscriptions: [], connectedAt: expect.any(String) });
      expect(stored().lastSeen).toBe(entry().connectedAt);
    });

    it('keeps the device\'s other connections', async () => {
      await open('c1');
      await open('c2', 'tq2');

      expect(Object.keys(stored().connections)).toEqual([ 'c1', 'c2' ]);
      expect(entry('c2').transport).toBe('tq2');
    });

    it('leaves an entry already under the id as it is', async () => {
      await open();
      await subscribe();

      expect(await open()).toBe(true);
      expect(entry().subscriptions).toEqual([ makeSub().getKey() ]);
    });

    /** A logout landing mid-registration ends the session before the connection opens. */
    it('opens nothing on a device whose session has ended or expired', async () => {
      for (const end of [ () => NexxusDevice.clearSession('d1'), () => NexxusDevice.setSession('d1', 's', nowSeconds() - 1) ]) {
        await end();

        expect(await open()).toBe(false);
        expect(stored().connections).toEqual({});
        expect(stored().lastSeen).toBeUndefined();
      }
    });

    it('throws when the device does not exist, or the id isn\'t valid', async () => {
      await expect(NexxusDevice.openConnection('ghost', 'c1', { transport: 'tq', type: 'volatile' })).rejects.toThrow(/not found/);
      await expect(open('a|b')).rejects.toThrow(/connection id/);
    });

    it('is handed back by get(), kept out of getValue()', async () => {
      await open();

      const device = await NexxusDevice.get('d1');

      expect(device.getConnections()).toEqual({ c1: entry() });
      expect(device.getValue()).not.toHaveProperty('connections');
    });
  });

  describe('addSubscription', () => {
    beforeEach(async () => { await open(); });

    it('lists the channel on the connection and routes it to that connection', async () => {
      await subscribe();

      expect(entry().subscriptions).toEqual([ makeSub().getKey() ]);
      expect(await makeSub().getAllDevices()).toEqual(new Set([ 'd1|tq|c1' ]));
      expect(await scopeCount()).toBe(1);
    });

    it('is harmless to repeat', async () => {
      await subscribe();
      await subscribe();

      expect(entry().subscriptions).toHaveLength(1);
      expect(await scopeCount()).toBe(1);
    });

    it('routes each connection on its own, on the same transport too', async () => {
      await open('c2');
      await subscribe('c1');
      await subscribe('c2');

      expect(await makeSub().getAllDevices()).toEqual(new Set([ 'd1|tq|c1', 'd1|tq|c2' ]));
      expect(await scopeCount()).toBe(2);
    });

    it('refuses a connection that is closing, or that does not exist', async () => {
      entry().closing = true;

      await expect(subscribe('c1')).rejects.toThrow(/not open/);
      await expect(subscribe('c9')).rejects.toThrow(/not open/);

      expect(await makeSub().getAllDevices()).toEqual(new Set());
      expect(await scopeCount()).toBe(0);
    });

    it('throws when the device does not exist', async () => {
      await expect(NexxusDevice.addSubscription('ghost', 'c1', makeSub())).rejects.toThrow(/not found/);
    });
  });

  /**
   * A subscribe sent just before a socket dies can land while its connection
   * is torn down. Wherever the teardown lands, no route may be left behind,
   * and the scope counter has to end where it started.
   */
  describe('a teardown racing a subscribe', () => {
    beforeEach(async () => { await open(); });

    /** A subscription whose route goes in with c1's teardown run just before or just after it. */
    const tornDown = (when: 'before' | 'after') => {
      const sub = makeSub();
      const addConnection = sub.addConnection.bind(sub);

      vi.spyOn(sub, 'addConnection').mockImplementationOnce(async (...args) => {
        if (when === 'before') await NexxusDevice.closeConnection('d1', 'c1');

        const added = await addConnection(...args);

        if (when === 'after') await NexxusDevice.closeConnection('d1', 'c1');

        return added;
      });

      return sub;
    };

    for (const when of [ 'before', 'after' ] as const) {
      it(`leaves no route when the teardown lands ${when} the route goes in`, async () => {
        await expect(subscribe('c1', tornDown(when))).rejects.toThrow(/closed while subscribing/);

        expect(await makeSub().getAllDevices()).toEqual(new Set());
        expect(await scopeCount()).toBe(0);
        expect(entry()).toBeUndefined();
      });
    }
  });

  describe('removeSubscription', () => {
    beforeEach(async () => { await open(); });

    it('removes the route, then the listing, and reports whether it was subscribed', async () => {
      await subscribe();

      expect(await NexxusDevice.removeSubscription('d1', 'c1', makeSub())).toBe(true);
      expect(entry().subscriptions).toEqual([]);
      expect(await makeSub().getAllDevices()).toEqual(new Set());
      expect(await scopeCount()).toBe(0);

      expect(await NexxusDevice.removeSubscription('d1', 'c1', makeSub())).toBe(false);
    });

    it('leaves the channel on the device\'s other connections', async () => {
      await open('c2');
      await subscribe('c1');
      await subscribe('c2');

      await NexxusDevice.removeSubscription('d1', 'c1', makeSub());

      expect(await makeSub().getAllDevices()).toEqual(new Set([ 'd1|tq|c2' ]));
      expect(entry('c2').subscriptions).toEqual([ makeSub().getKey() ]);
    });

    it('throws for a connection or a device that does not exist', async () => {
      await expect(NexxusDevice.removeSubscription('d1', 'c9', makeSub())).rejects.toThrow(/not open/);
      await expect(NexxusDevice.removeSubscription('ghost', 'c1', makeSub())).rejects.toThrow(/not found/);
    });
  });

  describe('closeConnection', () => {
    beforeEach(async () => { await open(); });

    it('removes the routes of every channel it lists, then its entry', async () => {
      await subscribe('c1', makeSub('r1'));
      await subscribe('c1', makeSub('r2'));

      expect(await NexxusDevice.closeConnection('d1', 'c1')).toBe(true);

      expect(entry()).toBeUndefined();
      expect(await makeSub('r1').getAllDevices()).toEqual(new Set());
      expect(await makeSub('r2').getAllDevices()).toEqual(new Set());
      expect(await scopeCount('r1')).toBe(0);
      expect(await scopeCount('r2')).toBe(0);
    });

    /**
     * A tab that reloads opens its new connection on the same node while the
     * old one closes. The old one's teardown must leave the new one's routes.
     */
    it('leaves the device\'s other connections alone, on the same transport too', async () => {
      await open('c2');
      await subscribe('c1');
      await subscribe('c2');

      await NexxusDevice.closeConnection('d1', 'c1');

      expect(entry('c2')).toMatchObject({ transport: 'tq', subscriptions: [ makeSub().getKey() ] });
      expect(await makeSub().getAllDevices()).toEqual(new Set([ 'd1|tq|c2' ]));
      expect(await scopeCount()).toBe(1);
    });

    it('finishes a teardown that was cut short', async () => {
      await subscribe();
      // As a process that died between marking the entry and deleting it leaves it.
      entry().closing = true;

      expect(await NexxusDevice.closeConnection('d1', 'c1')).toBe(true);

      expect(entry()).toBeUndefined();
      expect(await makeSub().getAllDevices()).toEqual(new Set());
      expect(await scopeCount()).toBe(0);
    });

    it('leaves what a failed teardown didn\'t get to for the next one', async () => {
      await subscribe();

      const removeConnection = vi.spyOn(NexxusRedisSubscription.prototype, 'removeConnection')
        .mockRejectedValueOnce(new Error('connection lost'));

      await expect(NexxusDevice.closeConnection('d1', 'c1')).rejects.toThrow('connection lost');
      removeConnection.mockRestore();

      expect(await NexxusDevice.closeConnection('d1', 'c1')).toBe(true);

      expect(entry()).toBeUndefined();
      expect(await makeSub().getAllDevices()).toEqual(new Set());
      expect(await scopeCount()).toBe(0);
    });

    it('can run twice at once, and each counter is decremented once', async () => {
      await subscribe();

      const results = await Promise.all([
        NexxusDevice.closeConnection('d1', 'c1'),
        NexxusDevice.closeConnection('d1', 'c1')
      ]);

      expect(results).toContain(true);
      expect(entry()).toBeUndefined();
      expect(await makeSub().getAllDevices()).toEqual(new Set());
      // Removed at zero, not left at zero or below.
      expect(await redis.hGetAll(SCOPES_KEY)).toEqual({});
    });

    it('returns false when there is nothing to tear down', async () => {
      expect(await NexxusDevice.closeConnection('d1', 'c9')).toBe(false);
      expect(await NexxusDevice.closeConnection('ghost', 'c1')).toBe(false);
    });
  });
});
