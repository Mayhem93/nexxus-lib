import { describe, it, expect, beforeEach } from 'vitest';
import { NexxusRedisSubscription, type NexxusSubscriptionChannel } from '@mayhem93/nexxus-redis';
import { NexxusFilterQuery, NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';
import { installFakeRedis } from './helpers';
import type { FakeRedis } from './fakeRedis';

const sub = (channel: NexxusSubscriptionChannel, filterId?: string) => new NexxusRedisSubscription(channel, filterId);

const makeFilter = () => new NexxusFilterQuery({ status: 'active' }, { status: { type: 'string', filterable: true } });

describe('NexxusRedisSubscription.getKey', () => {
  it('builds keys for each channel shape', () => {
    expect(sub({ appId: 'a', model: 'runs' }).getKey()).toBe(`${NEXXUS_PREFIX_LC}:subscription:a:runs`);
    expect(sub({ appId: 'a', model: 'runs', modelId: 'r1' }).getKey()).toBe(`${NEXXUS_PREFIX_LC}:subscription:a:runs:r1`);
    expect(sub({ appId: 'a', model: 'runs', userId: 'u1' }).getKey()).toBe(`${NEXXUS_PREFIX_LC}:subscription:a:runs:user:u1`);
  });

  it('drops userId from the key when a modelId is present (redundant)', () => {
    expect(sub({ appId: 'a', model: 'runs', modelId: 'r1', userId: 'u1' }).getKey())
      .toBe(`${NEXXUS_PREFIX_LC}:subscription:a:runs:r1`);
  });

  it('appends a filter segment for filtered subscriptions', () => {
    const s = sub({ appId: 'a', model: 'runs', filter: makeFilter() });

    expect(s.getKey()).toMatch(new RegExp(`^${NEXXUS_PREFIX_LC}:subscription:a:runs:filter:[0-9a-f]{16}$`));
  });
});

describe('NexxusRedisSubscription.fromKey', () => {
  it('round-trips a plain, modelId, and userId key', () => {
    for (const channel of [
      { appId: 'a', model: 'runs' },
      { appId: 'a', model: 'runs', modelId: 'r1' },
      { appId: 'a', model: 'runs', userId: 'u1' },
    ] as NexxusSubscriptionChannel[]) {
      const key = sub(channel).getKey();

      expect(NexxusRedisSubscription.fromKey(key).getKey()).toBe(key);
    }
  });

  it('parses a key carrying both a filter and a userId', () => {
    const parsed = NexxusRedisSubscription.fromKey(`${NEXXUS_PREFIX_LC}:subscription:a:runs:user:u1:filter:deadbeefdeadbeef`);

    expect(parsed.getKey()).toBe(`${NEXXUS_PREFIX_LC}:subscription:a:runs:user:u1:filter:deadbeefdeadbeef`);
  });
});

describe('NexxusRedisSubscription.buildScopeDescriptor', () => {
  it('encodes the scope dimensions deterministically', () => {
    expect(NexxusRedisSubscription.buildScopeDescriptor({ appId: 'a', model: 'runs' })).toBe('*');
    expect(NexxusRedisSubscription.buildScopeDescriptor({ appId: 'a', model: 'runs', modelId: 'r1' })).toBe('id:r1');
    expect(NexxusRedisSubscription.buildScopeDescriptor({ appId: 'a', model: 'runs', userId: 'u1' })).toBe('user:u1');
    expect(NexxusRedisSubscription.buildScopeDescriptor({ appId: 'a', model: 'runs', modelId: 'r1', userId: 'u1' })).toBe('id:r1|user:u1');
  });
});

describe('NexxusRedisSubscription.generateSubscriptionPatterns', () => {
  it('yields only the app+model pattern for a bare channel', () => {
    const patterns = [...NexxusRedisSubscription.generateSubscriptionPatterns({ appId: 'a', model: 'runs' })];

    expect(patterns).toEqual([{ appId: 'a', model: 'runs' }]);
  });

  it('yields all scope combinations for a full channel', () => {
    const patterns = [...NexxusRedisSubscription.generateSubscriptionPatterns({ appId: 'a', model: 'runs', userId: 'u1', modelId: 'r1' })];

    expect(patterns).toEqual([
      { appId: 'a', model: 'runs' },
      { appId: 'a', model: 'runs', userId: 'u1' },
      { appId: 'a', model: 'runs', modelId: 'r1' },
      { appId: 'a', userId: 'u1', model: 'runs' },
      { appId: 'a', userId: 'u1', model: 'runs', modelId: 'r1' },
    ]);
  });
});

describe('NexxusRedisSubscription device membership (stateful)', () => {
  let redis: FakeRedis;

  beforeEach(() => { redis = installFakeRedis(); });

  it('adds devices and lists them, deduping identical members', async () => {
    const s = sub({ appId: 'a', model: 'runs' });

    await s.addDevice('dev1', 'tq');
    await s.addDevice('dev1', 'tq'); // duplicate — must not double-count the scope
    await s.addDevice('dev2', 'tq');

    expect(await s.getAllDevices()).toEqual(new Set(['dev1|tq', 'dev2|tq']));
    expect(await NexxusRedisSubscription.getActiveScopes('a', 'runs')).toEqual(new Set(['*']));
  });

  it('removes a device and reports whether it existed', async () => {
    const s = sub({ appId: 'a', model: 'runs' });

    await s.addDevice('dev1', 'tq');

    expect(await s.removeDevice('dev1', 'tq')).toBe(true);
    expect(await s.removeDevice('dev1', 'tq')).toBe(false); // already gone
    expect(await s.getAllDevices()).toEqual(new Set());
  });

  it('clears the scope registry once the last subscriber leaves (dedup keeps the count at 1)', async () => {
    const s = sub({ appId: 'a', model: 'runs' });

    await s.addDevice('dev1', 'tq');
    await s.addDevice('dev1', 'tq'); // dup: scope stays at 1, not 2

    await s.removeDevice('dev1', 'tq');

    // If the dup had double-counted, the scope would still be at 1 here.
    expect(await NexxusRedisSubscription.getActiveScopes('a', 'runs')).toEqual(new Set());
  });

  it('returns an empty device set when nothing is subscribed', async () => {
    expect(await sub({ appId: 'a', model: 'runs' }).getAllDevices()).toEqual(new Set());
  });

  it('scopes membership and filters by modelId', async () => {
    const channel: NexxusSubscriptionChannel = { appId: 'a', model: 'runs', modelId: 'r1', filter: makeFilter() };
    const s = sub(channel);

    await s.addDevice('dev1', 'tq');

    expect(await s.getAllDevices()).toEqual(new Set(['dev1|tq']));
    expect(Object.keys(await NexxusRedisSubscription.getAllFilters(channel))).toHaveLength(1);
  });

  it('scopes membership and filters by userId', async () => {
    const channel: NexxusSubscriptionChannel = { appId: 'a', model: 'runs', userId: 'u1', filter: makeFilter() };
    const s = sub(channel);

    await s.addDevice('dev2', 'tq');

    expect(await s.getAllDevices()).toEqual(new Set(['dev2|tq']));
    expect(Object.keys(await NexxusRedisSubscription.getAllFilters(channel))).toHaveLength(1);
  });

  it('stores and removes filter definitions for filtered subscriptions', async () => {
    const channel: NexxusSubscriptionChannel = { appId: 'a', model: 'runs', filter: makeFilter() };
    const s = sub(channel);

    await s.addDevice('dev1', 'tq');

    const filters = await NexxusRedisSubscription.getAllFilters(channel);

    expect(Object.keys(filters)).toHaveLength(1);
    expect(Object.values(filters)[0]).toEqual({ status: 'active' });

    await s.removeDevice('dev1', 'tq'); // last subscriber → filter registry entry dropped

    expect(await NexxusRedisSubscription.getAllFilters(channel)).toEqual({});
  });
});
