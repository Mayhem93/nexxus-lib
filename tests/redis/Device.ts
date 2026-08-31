import { describe, it, expect, beforeEach } from 'vitest';
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
});
