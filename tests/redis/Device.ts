import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NexxusDevice, NexxusRedisSubscription } from '@mayhem93/nexxus-redis';
import { NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';
import { installFakeRedis, logger } from './helpers';
import type { FakeRedis } from './fakeRedis';

let redis: FakeRedis;

beforeEach(() => { redis = installFakeRedis(); });

const makeSub = (modelId = 'r1') => new NexxusRedisSubscription({ appId: 'a', model: 'runs', modelId });

describe('NexxusDevice constructor', () => {
  it('applies defaults and preserves a caller id', () => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: undefined as never, subscriptions: [] });
    const data = d.getValue();

    expect(data.id).toBe('d1');
    expect(data.name).toBe('Unnamed Device');
    expect(data.type).toBe('unknown');
    expect(data.subscriptions).toEqual([]);
  });

  it('generates a uuid id when none is given', () => {
    const d = new NexxusDevice({ appId: 'a', name: 'N', subscriptions: [] } as never);

    expect(d.getValue().id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('requires an appId', () => {
    expect(() => new NexxusDevice({ appId: undefined as never, id: 'd1', name: 'N', subscriptions: [] }))
      .toThrow(/appId is required/);
  });

  it('parses a lastSeen string into a Date', () => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', subscriptions: [], lastSeen: '2020-01-01T00:00:00.000Z' });

    expect(d.getValue().lastSeen).toBeInstanceOf(Date);
  });
});

describe('NexxusDevice getKey / get / save', () => {
  it('builds the device key', () => {
    expect(NexxusDevice.getKey('d1')).toBe(`${NEXXUS_PREFIX_LC}:device:d1`);
    expect(new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', subscriptions: [] }).getKey()).toBe(`${NEXXUS_PREFIX_LC}:device:d1`);
  });

  it('saves and reads a device back', async () => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'Phone', type: 'volatile', transport: 'tq', subscriptions: [] }).save();

    const loaded = await NexxusDevice.get('d1');

    expect(loaded.getValue()).toMatchObject({ id: 'd1', appId: 'a', name: 'Phone', type: 'volatile', transport: 'tq' });
  });

  it('throws when getting a non-existent device', async () => {
    await expect(NexxusDevice.get('ghost')).rejects.toThrow(/not found/);
  });

  it('rejects saving a device that has subscriptions but no transport', async () => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', subscriptions: [makeSub()] });

    await expect(d.save()).rejects.toThrow(/must be connected to a transport/);
  });

  it('registers each subscription on save and can hydrate them back', async () => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', transport: 'tq', subscriptions: [makeSub()] });

    await d.save();

    // The subscription now knows about the device.
    expect(await makeSub().getAllDevices()).toEqual(new Set(['d1|tq']));

    const withSubs = await NexxusDevice.get('d1', true);

    expect(withSubs.getValue().subscriptions).toHaveLength(1);
    expect(withSubs.getValue().subscriptions[0].getKey()).toBe(makeSub().getKey());
  });
});

describe('NexxusDevice.exists', () => {
  it('tells which devices exist, with one single-key EXISTS per id', async () => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', subscriptions: [] }).save();

    const exists = vi.spyOn(redis, 'exists');

    expect(await NexxusDevice.exists(['d1', 'ghost'])).toEqual(new Map([['d1', true], ['ghost', false]]));
    // A cluster refuses a single command whose keys live on different nodes.
    expect(exists.mock.calls).toEqual([[NexxusDevice.getKey('d1')], [NexxusDevice.getKey('ghost')]]);
  });
});

describe('NexxusDevice.update', () => {
  beforeEach(async () => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', type: 'volatile', transport: 'tq', subscriptions: [] }).save();
  });

  it('updates allowed string fields', async () => {
    await NexxusDevice.update('d1', { name: 'Renamed', status: 'online' });

    expect((await NexxusDevice.get('d1')).getValue()).toMatchObject({ name: 'Renamed', status: 'online' });
  });

  it('stores a lastSeen Date as an ISO string, rejecting non-Dates', async () => {
    await NexxusDevice.update('d1', { lastSeen: new Date('2020-01-01T00:00:00.000Z') });

    expect((redis.store.get(NexxusDevice.getKey('d1')) as { value: any }).value.lastSeen).toBe('2020-01-01T00:00:00.000Z');
    await expect(NexxusDevice.update('d1', { lastSeen: 'nope' as never })).rejects.toThrow(/expected Date/);
  });

  it('rejects a non-string transport', async () => {
    await expect(NexxusDevice.update('d1', { transport: 5 as never })).rejects.toThrow(/expected string/);
  });

  it('rejects updating userId — the update type permits it but the impl does not', async () => {
    // Flagged inconsistency: NexxusDeviceUpdateProps allows userId, but update() has no case for it.
    await expect(NexxusDevice.update('d1', { userId: 'u2' })).rejects.toThrow(/Unknown field "userId"/);
  });

  it('is a no-op when every update value is undefined', async () => {
    await NexxusDevice.update('d1', { name: undefined });

    expect((await NexxusDevice.get('d1')).getValue().name).toBe('N');
  });

  it('throws a command error when the target device does not exist', async () => {
    await expect(NexxusDevice.update('ghost', { name: 'x' })).rejects.toThrow(/Failed to update device/);
  });
});

describe('NexxusDevice subscriptions', () => {
  const makeConnectedDevice = () => new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', transport: 'tq', subscriptions: [] });

  it('adds a subscription, deduping repeats', async () => {
    const d = makeConnectedDevice();

    await d.save();

    expect(await d.addSubscription(makeSub())).toBe(true);
    expect(await d.addSubscription(makeSub())).toBe(false); // already present
    expect(d.getValue().subscriptions).toHaveLength(1);
    expect(await makeSub().getAllDevices()).toEqual(new Set(['d1|tq']));
  });

  it('rejects adding a subscription while not connected to a transport', async () => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', subscriptions: [] });

    await expect(d.addSubscription(makeSub())).rejects.toThrow(/not connected to any transport/);
  });

  it('removes a subscription, reporting whether it was present', async () => {
    const d = makeConnectedDevice();

    await d.save();
    await d.addSubscription(makeSub());

    expect(await d.removeSubscription(makeSub())).toBe(true);
    expect(await d.removeSubscription(makeSub())).toBe(false);
    expect(d.getValue().subscriptions).toHaveLength(0);
    expect(await makeSub().getAllDevices()).toEqual(new Set());
  });

  it('rejects removing a subscription while not connected to a transport', async () => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', subscriptions: [] });

    await expect(d.removeSubscription(makeSub())).rejects.toThrow(/not registered with any transport/);
  });

  it('hasSubscription throws when the device is not persisted', async () => {
    const d = makeConnectedDevice(); // not saved

    await expect(d.hasSubscription(makeSub())).rejects.toThrow(/not found/);
  });

  it('removeAllSubscriptions unsubscribes each and clears the list', async () => {
    const d = makeConnectedDevice();

    await d.save();
    await d.addSubscription(makeSub('r1'));
    await d.addSubscription(makeSub('r2'));

    await NexxusDevice.removeAllSubscriptions('d1');

    expect((await NexxusDevice.get('d1', true)).getValue().subscriptions).toHaveLength(0);
    expect(await makeSub('r1').getAllDevices()).toEqual(new Set());
  });

  it('warns (and still clears) when removing subscriptions from a device with no transport', async () => {
    // Persist a device that has subscription keys but no transport (bypass save()'s guard).
    redis.store.set(NexxusDevice.getKey('d2'), {
      type: 'json',
      value: { id: 'd2', appId: 'a', name: 'N', type: 'unknown', transport: null, subscriptions: [makeSub().getKey()] },
    } as never);

    await NexxusDevice.removeAllSubscriptions('d2');

    expect(logger.has('warning', /not connected to any transport/)).toBe(true);
    expect((await NexxusDevice.get('d2', true)).getValue().subscriptions).toHaveLength(0);
  });

  it('removeAllSubscriptions writes nothing for a device with none listed', async () => {
    await makeConnectedDevice().save();

    const clear = vi.spyOn(redis.json, 'clear');

    await NexxusDevice.removeAllSubscriptions('d1');

    expect(clear).not.toHaveBeenCalled();
  });
});

describe('NexxusDevice.detachTransport', () => {
  const storedDevice = (): any => (redis.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;

  /** A device on `transport`, subscribed to r1 and r2. */
  const connectedDevice = async (transport: string): Promise<void> => {
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', transport, status: 'online', subscriptions: [] });

    await d.save();
    await d.addSubscription(makeSub('r1'));
    await d.addSubscription(makeSub('r2'));
  };

  it('removes the routes through the transport and marks the device offline', async () => {
    await connectedDevice('tq');

    expect(await NexxusDevice.detachTransport('d1', 'tq')).toBe(true);

    expect(storedDevice()).toMatchObject({ subscriptions: [], status: 'offline', transport: null });
    expect(typeof storedDevice().lastSeen).toBe('string'); // ISO timestamp
    expect(await makeSub('r1').getAllDevices()).toEqual(new Set());
    expect(await makeSub('r2').getAllDevices()).toEqual(new Set());
  });

  /**
   * A connection that closes after its device has registered on another
   * transport must not touch what that registration set up.
   */
  it('leaves a device that has registered on another transport alone', async () => {
    await connectedDevice('tq2');

    expect(await NexxusDevice.detachTransport('d1', 'tq')).toBe(false);

    expect(storedDevice()).toMatchObject({ status: 'online', transport: 'tq2' });
    expect(storedDevice().subscriptions).toHaveLength(2);
    expect(await makeSub('r1').getAllDevices()).toEqual(new Set([ 'd1|tq2' ]));
  });

  it('leaves the record alone when the other registration lands between the read and the write', async () => {
    await connectedDevice('tq');

    // The registration elsewhere: it clears what this connection listed and
    // takes the device over.
    redis.beforeEval = () => {
      Object.assign(storedDevice(), { subscriptions: [], status: 'online', transport: 'tq2' });
    };

    expect(await NexxusDevice.detachTransport('d1', 'tq')).toBe(false);

    expect(storedDevice()).toMatchObject({ status: 'online', transport: 'tq2' });
    // Its routes through `tq` are gone all the same.
    expect(await makeSub('r1').getAllDevices()).toEqual(new Set());
  });

  it('throws when the device does not exist', async () => {
    await expect(NexxusDevice.detachTransport('ghost', 'tq')).rejects.toThrow(/not found/);
  });
});

describe('NexxusDevice.attachTransport', () => {
  const storedDevice = (): any => (redis.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;

  /** A device that has never connected, with a session ending at `expiresAt`, or none. */
  const deviceWithSession = async (expiresAt?: number): Promise<void> => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', subscriptions: [] }).save();

    if (expiresAt !== undefined) {
      await NexxusDevice.setSession('d1', 'secret', expiresAt);
    }
  };

  it('marks a device with a live session online on the transport', async () => {
    await deviceWithSession(nowSeconds() + DAY);

    expect(await NexxusDevice.attachTransport('d1', 'tq')).toBe(true);

    expect(storedDevice()).toMatchObject({ type: 'volatile', status: 'online', transport: 'tq' });
    expect(typeof storedDevice().lastSeen).toBe('string'); // ISO timestamp
  });

  /** A logout landing mid-registration ends the session before the device goes online. */
  it('leaves a device whose session has ended or expired as it is', async () => {
    for (const expiresAt of [ undefined, nowSeconds() - 1 ]) {
      redis.store.clear();
      await deviceWithSession(expiresAt);

      expect(await NexxusDevice.attachTransport('d1', 'tq')).toBe(false);
      expect(storedDevice().status).toBeUndefined();
      expect(storedDevice().transport).toBeUndefined();
    }
  });

  it('throws when the device does not exist', async () => {
    await expect(NexxusDevice.attachTransport('ghost', 'tq')).rejects.toThrow(/not found/);
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
    const d = new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', subscriptions: [] });

    await d.save();
    await NexxusDevice.setSession('d1', 's1', nowSeconds() + DAY);

    await expect(d.save()).rejects.toThrow(/already exists/);
    expect(storedSession()).toBeDefined();
  });
});

describe('NexxusDevice sessions', () => {
  beforeEach(async () => {
    await new NexxusDevice({ appId: 'a', id: 'd1', name: 'N', subscriptions: [] }).save();
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
