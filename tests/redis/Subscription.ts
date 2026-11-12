import { describe, it, expect, beforeEach, vi } from 'vitest';
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
      { appId: 'a', model: 'runs', modelId: 'r1', userId: 'u1' },
    ]);
  });

  it('yields only the scopes the channel actually has dimensions for', () => {
    expect([...NexxusRedisSubscription.generateSubscriptionPatterns({ appId: 'a', model: 'runs', userId: 'u1' })])
      .toEqual([
        { appId: 'a', model: 'runs' },
        { appId: 'a', model: 'runs', userId: 'u1' },
      ]);

    expect([...NexxusRedisSubscription.generateSubscriptionPatterns({ appId: 'a', model: 'runs', modelId: 'r1' })])
      .toEqual([
        { appId: 'a', model: 'runs' },
        { appId: 'a', model: 'runs', modelId: 'r1' },
      ]);
  });

  /**
   * The generator used to yield `{ appId, model, userId }` twice (once directly,
   * once inside a second userId branch). Both copies produced the same scope
   * descriptor and the same Redis keys, so every event carrying a userId did the
   * whole userId-scope round trip — devices, filters, and a device lookup per
   * matching filter — a second time for nothing.
   */
  it('never yields two patterns that resolve to the same scope', () => {
    const patterns = [...NexxusRedisSubscription.generateSubscriptionPatterns({ appId: 'a', model: 'runs', userId: 'u1', modelId: 'r1' })];
    const descriptors = patterns.map(p => NexxusRedisSubscription.buildScopeDescriptor(p));

    expect(descriptors).toEqual(['*', 'user:u1', 'id:r1', 'id:r1|user:u1']);
    expect(new Set(descriptors).size).toBe(patterns.length);
  });
});

describe('NexxusRedisSubscription device membership (stateful)', () => {
  let redis: FakeRedis;

  beforeEach(() => { redis = installFakeRedis(); });

  it('adds devices and lists them, deduping identical members', async () => {
    const s = sub({ appId: 'a', model: 'runs' });

    await s.addConnection('dev1', 'tq', 'c1');
    await s.addConnection('dev1', 'tq', 'c1'); // duplicate — must not double-count the scope
    await s.addConnection('dev2', 'tq', 'c1');

    expect(await s.getAllDevices()).toEqual(new Set(['dev1|tq|c1', 'dev2|tq|c1']));
    expect(await NexxusRedisSubscription.getActiveScopes('a', 'runs')).toEqual(new Set(['*']));
  });

  it('removes a device and reports whether it existed', async () => {
    const s = sub({ appId: 'a', model: 'runs' });

    await s.addConnection('dev1', 'tq', 'c1');

    expect(await s.removeConnection('dev1', 'tq', 'c1')).toBe(true);
    expect(await s.removeConnection('dev1', 'tq', 'c1')).toBe(false); // already gone
    expect(await s.getAllDevices()).toEqual(new Set());
  });

  it('clears the scope registry once the last subscriber leaves (dedup keeps the count at 1)', async () => {
    const s = sub({ appId: 'a', model: 'runs' });

    await s.addConnection('dev1', 'tq', 'c1');
    await s.addConnection('dev1', 'tq', 'c1'); // dup: scope stays at 1, not 2

    await s.removeConnection('dev1', 'tq', 'c1');

    // If the dup had double-counted, the scope would still be at 1 here.
    expect(await NexxusRedisSubscription.getActiveScopes('a', 'runs')).toEqual(new Set());
  });

  it('returns an empty device set when nothing is subscribed', async () => {
    expect(await sub({ appId: 'a', model: 'runs' }).getAllDevices()).toEqual(new Set());
  });

  it('scopes membership and filters by modelId', async () => {
    const channel: NexxusSubscriptionChannel = { appId: 'a', model: 'runs', modelId: 'r1', filter: makeFilter() };
    const s = sub(channel);

    await s.addConnection('dev1', 'tq', 'c1');

    expect(await s.getAllDevices()).toEqual(new Set(['dev1|tq|c1']));
    expect(Object.keys(await NexxusRedisSubscription.getAllFilters(channel))).toHaveLength(1);
  });

  it('scopes membership and filters by userId', async () => {
    const channel: NexxusSubscriptionChannel = { appId: 'a', model: 'runs', userId: 'u1', filter: makeFilter() };
    const s = sub(channel);

    await s.addConnection('dev2', 'tq', 'c1');

    expect(await s.getAllDevices()).toEqual(new Set(['dev2|tq|c1']));
    expect(Object.keys(await NexxusRedisSubscription.getAllFilters(channel))).toHaveLength(1);
  });

  it('stores and removes filter definitions for filtered subscriptions', async () => {
    const channel: NexxusSubscriptionChannel = { appId: 'a', model: 'runs', filter: makeFilter() };
    const s = sub(channel);

    await s.addConnection('dev1', 'tq', 'c1');

    const filters = await NexxusRedisSubscription.getAllFilters(channel);

    expect(Object.keys(filters)).toHaveLength(1);
    expect(Object.values(filters)[0]).toEqual({ status: 'active' });

    await s.removeConnection('dev1', 'tq', 'c1'); // last subscriber → filter registry entry dropped

    expect(await NexxusRedisSubscription.getAllFilters(channel)).toEqual({});
  });
});

/**
 * What the Transport Manager reads before it reads routes: the scope counter,
 * the partition index and, for a filtered subscription, the filter's
 * definition. A route that exists has to be counted in each of them, or the
 * Transport Manager never finds it.
 */
describe('NexxusRedisSubscription counts', () => {
  let redis: FakeRedis;

  beforeEach(() => { redis = installFakeRedis(); });

  const filtered = (): NexxusRedisSubscription => sub({ appId: 'a', model: 'runs', modelId: 'r1', filter: makeFilter() });

  const partitionOf = (s: NexxusRedisSubscription, deviceId: string): string =>
    (s as unknown as { getDevicePartition(id: string): string }).getDevicePartition(deviceId);

  /** A device id whose routes share `deviceId`'s partition. */
  const partitionMate = (s: NexxusRedisSubscription, deviceId: string): string => {
    for (let i = 0; ; i++) {
      if (`mate${i}` !== deviceId && partitionOf(s, `mate${i}`) === partitionOf(s, deviceId)) {
        return `mate${i}`;
      }
    }
  };

  /** Each count `deviceId`'s routes on `s` are kept under, as stored now; 0 when it is gone. */
  const counts = async (s: NexxusRedisSubscription, deviceId: string) => {
    const filterId = s.getKey().split(':filter:')[1]!;
    const filters = await redis.hGetAll(`${NEXXUS_PREFIX_LC}:subscription-filters:a:runs:r1`);
    const partitions = await redis.hGetAll(`${NEXXUS_PREFIX_LC}:subscription-partition-index:a:runs:r1:filter:${filterId}`);
    const scopes = await redis.hGetAll(`${NEXXUS_PREFIX_LC}:subscription-scopes:a:runs`);

    return {
      scope: Number(scopes['id:r1'] ?? 0),
      partition: Number(partitions[partitionOf(s, deviceId)] ?? 0),
      filter: Number(filters[`count:${filterId}`] ?? 0),
      defined: filters[filterId] !== undefined,
    };
  };

  it('counts a route before adding it, and releases it only after removing it', async () => {
    const s = filtered();
    const sAdd = redis.sAdd.bind(redis);
    const sRem = redis.sRem.bind(redis);
    let atAdd: unknown;
    let atRemove: unknown;

    vi.spyOn(redis, 'sAdd').mockImplementation(async (key, member) => {
      atAdd = await counts(s, 'dev1');

      return sAdd(key, member);
    });
    vi.spyOn(redis, 'sRem').mockImplementation(async (key, member) => {
      const removed = await sRem(key, member);

      atRemove = await counts(s, 'dev1');

      return removed;
    });

    await s.addConnection('dev1', 'tq', 'c1');
    expect(atAdd).toEqual({ scope: 1, partition: 1, filter: 1, defined: true });

    await s.removeConnection('dev1', 'tq', 'c1');
    expect(atRemove).toEqual({ scope: 1, partition: 1, filter: 1, defined: true });
    expect(await counts(s, 'dev1')).toEqual({ scope: 0, partition: 0, filter: 0, defined: false });
  });

  it('keeps a route counted when the last other route in its partition leaves as it is added', async () => {
    const s = filtered();
    const mate = partitionMate(s, 'dev1');
    const sAdd = redis.sAdd.bind(redis);

    await s.addConnection(mate, 'tq', 'c1');

    // The other route leaves after this one is counted, before it is added.
    vi.spyOn(redis, 'sAdd').mockImplementationOnce(async (key, member) => {
      await s.removeConnection(mate, 'tq', 'c1');

      return sAdd(key, member);
    });

    await s.addConnection('dev1', 'tq', 'c1');

    expect(await s.getAllDevices()).toEqual(new Set([ 'dev1|tq|c1' ]));
    expect(await counts(s, 'dev1')).toEqual({ scope: 1, partition: 1, filter: 1, defined: true });
  });

  it('keeps a filter definition when the last other route using it leaves as it is stored', async () => {
    const s = filtered();
    const hSet = redis.hSet.bind(redis);

    await s.addConnection('dev2', 'tq', 'c1');

    // The other route leaves just after this one stores the definition.
    vi.spyOn(redis, 'hSet').mockImplementationOnce(async (...args: Parameters<FakeRedis['hSet']>) => {
      const stored = await hSet(...args);

      await s.removeConnection('dev2', 'tq', 'c1');

      return stored;
    });

    await s.addConnection('dev1', 'tq', 'c1');

    expect(await counts(s, 'dev1')).toEqual({ scope: 1, partition: 1, filter: 1, defined: true });
  });

  it('takes the counts back when the route already existed', async () => {
    const s = filtered();

    expect(await s.addConnection('dev1', 'tq', 'c1')).toBe(true);
    expect(await s.addConnection('dev1', 'tq', 'c1')).toBe(false);
    expect(await counts(s, 'dev1')).toEqual({ scope: 1, partition: 1, filter: 1, defined: true });
  });

  it('releases a route once when two callers remove it at the same moment', async () => {
    const s = filtered();

    await s.addConnection('dev1', 'tq', 'c1');
    await s.addConnection(partitionMate(s, 'dev1'), 'tq', 'c1');

    const removed = await Promise.all([ s.removeConnection('dev1', 'tq', 'c1'), s.removeConnection('dev1', 'tq', 'c1') ]);

    expect(removed.sort()).toEqual([ false, true ]);
    expect(await counts(s, 'dev1')).toEqual({ scope: 1, partition: 1, filter: 1, defined: true });
  });

  it('keeps a filter definition while a route uses it, and lists only definitions', async () => {
    const s = filtered();

    await s.addConnection('dev1', 'tq', 'c1');
    await s.addConnection('dev2', 'tq', 'c1');
    await s.removeConnection('dev1', 'tq', 'c1');

    expect(await NexxusRedisSubscription.getAllFilters({ appId: 'a', model: 'runs', modelId: 'r1' }))
      .toEqual({ [s.getKey().split(':filter:')[1]!]: { status: 'active' } });

    await s.removeConnection('dev2', 'tq', 'c1');

    expect(await redis.hGetAll(`${NEXXUS_PREFIX_LC}:subscription-filters:a:runs:r1`)).toEqual({});
  });
});
