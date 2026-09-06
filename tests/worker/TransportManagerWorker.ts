import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NexxusTransportManagerWorker, NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { NexxusApplication, NexxusFilterQuery, NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';
import { NexxusRedisSubscription, type NexxusSubscriptionChannel } from '@mayhem93/nexxus-redis';
import { makeHarness, logger, mqState, resetWorkerStatics, type WorkerHarness } from './harness';

const workers: NexxusTransportManagerWorker[] = [];
let h: WorkerHarness;

beforeEach(async () => {
  resetWorkerStatics(NexxusBaseWorker);
  h = await makeHarness();
});

afterEach(async () => {
  for (const w of workers) await w.close().catch(() => {});
  workers.length = 0;
});

const tm = (): any => {
  const w = new NexxusTransportManagerWorker(h.services);

  workers.push(w);

  return w;
};

/* --- fixtures --------------------------------------------------------- */
/** Two distinct transport-worker queues, as they appear in a `deviceId|transport` member. */
const T1 = 'websockets-transport_1';
const T2 = 'websockets-transport_2';

const SCHEMA = {
  runs: {
    fields: {
      title: { type: 'string' },
      count: { type: 'int', filterable: true },
      status: { type: 'string', filterable: true },
    },
  },
};

const AUTH = { jwtSecret: 's', strategies: { local: {} }, userDetailSchema: { default: {} } };

/** Register an app in the worker's shared registry. `auth` makes `userId` a filterable field. */
const loadApp = (opts: { auth?: boolean } = {}): NexxusApplication => {
  const app = new NexxusApplication({
    id: 'app1', type: 'application', name: 'A', schema: SCHEMA,
    ...(opts.auth ? { auth: AUTH } : {}),
  } as never);

  (NexxusBaseWorker as any).loadedApps.set('app1', app);

  return app;
};

const filterOn = (query: Record<string, unknown>, opts: { auth?: boolean } = {}): NexxusFilterQuery =>
  new NexxusFilterQuery(query as never, {
    ...SCHEMA.runs.fields,
    ...(opts.auth ? { userId: { type: 'string', required: true, filterable: true } } : {}),
  } as never);

/**
 * Subscribe a device through the REAL subscription model, so the partition set,
 * partition index, scope registry and filter registry are all written exactly
 * as the API writes them. Returns the channel key the TM should report back.
 */
const subscribe = async (
  channel: NexxusSubscriptionChannel,
  deviceId: string,
  transport: string = T1
): Promise<string> => {
  const sub = new NexxusRedisSubscription(channel);

  await sub.addDevice(deviceId, transport);

  return sub.getKey();
};

/** The scope-registry HASH the TM reads to decide which patterns are worth a lookup. */
const scopeRegistryKey = (model = 'runs') => `${NEXXUS_PREFIX_LC}:subscription-scopes:app1:${model}`;

const created = (over: Record<string, unknown> = {}) => ({
  payload: {
    event: 'model_created',
    data: { id: 'r1', appId: 'app1', type: 'runs', title: 'hello', count: 5, status: 'active', ...over },
  },
});

const deleted = (over: Record<string, unknown> = {}) => ({
  payload: { event: 'model_deleted', data: { id: 'r1', appId: 'app1', type: 'runs', ...over } },
});

/** A writer-shaped patch: `over` tweaks the op, `partial` the post-update partial model, `meta` the identity. */
const patch = (
  over: Record<string, unknown> = {},
  partial: Record<string, unknown> = {},
  meta: Record<string, unknown> = {}
) => ({
  op: 'replace',
  path: ['title'],
  value: ['new title'],
  ...over,
  metadata: {
    id: 'r1', type: 'runs', appId: 'app1',
    ...meta,
    partialModel: { id: 'r1', type: 'runs', title: 'new title', count: 5, status: 'active', version: 7, ...partial },
  },
});

const updated = (patches?: any[]) => ({
  payload: { event: 'model_updated', data: patches ?? [ patch() ] },
});

/** Every publish that landed on `queue`. */
const onQueue = (queue: string) => mqState.published.filter(p => p.queue === queue);

describe('NexxusTransportManagerWorker event dispatch', () => {
  it('warns and drops an event it does not handle', async () => {
    await tm().processMessage({ payload: { event: 'model_exploded' } });

    expect(logger.has('warning', /Unknown event type: model_exploded/)).toBe(true);
    expect(mqState.published).toHaveLength(0);
  });

  it('warns and publishes nothing when the app is not loaded', async () => {
    await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    await tm().processMessage(created());

    expect(logger.has('warning', /Application not found for appId: "app1"/)).toBe(true);
    expect(mqState.published).toHaveLength(0);
  });

  it('publishes nothing when nobody subscribed to the model at any scope', async () => {
    loadApp();

    await tm().processMessage(created());

    expect(mqState.published).toHaveLength(0);
  });
});

describe('NexxusTransportManagerWorker model_created', () => {
  it('notifies an unfiltered subscriber on its own transport queue', async () => {
    loadApp();

    const channelKey = await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    await tm().processMessage(created());

    expect(mqState.published).toHaveLength(1);
    expect(mqState.published[0].queue).toBe(T1);
    expect(mqState.published[0].message).toEqual({
      event: 'device_message',
      deviceIds: [ 'd1' ],
      data: {
        event: 'model_created',
        model: created().payload.data,
        metadata: { channels: [ channelKey ] },
      },
    });
  });

  it('batches every device that matched the same channels into ONE message', async () => {
    loadApp();

    const channelKey = await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    await subscribe({ appId: 'app1', model: 'runs' }, 'd2');
    await subscribe({ appId: 'app1', model: 'runs' }, 'd3');

    await tm().processMessage(created());

    expect(mqState.published).toHaveLength(1);
    expect(mqState.published[0].message.deviceIds.sort()).toEqual([ 'd1', 'd2', 'd3' ]);
    expect(mqState.published[0].message.data.metadata.channels).toEqual([ channelKey ]);
  });

  it('splits devices that matched DIFFERENT channels into separate messages', async () => {
    loadApp();

    const appChannel = await subscribe({ appId: 'app1', model: 'runs' }, 'd1');
    const idChannel = await subscribe({ appId: 'app1', model: 'runs', modelId: 'r1' }, 'd2');

    await tm().processMessage(created());

    const messages = onQueue(T1);

    expect(messages).toHaveLength(2);
    expect(messages.map(m => [ m.message.deviceIds, m.message.data.metadata.channels ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      [ [ 'd1' ], [ appChannel ] ],
      [ [ 'd2' ], [ idChannel ] ],
    ]);
  });

  it('merges every channel a single device matched on into that device\'s one message', async () => {
    loadApp();

    const appChannel = await subscribe({ appId: 'app1', model: 'runs' }, 'd1');
    const idChannel = await subscribe({ appId: 'app1', model: 'runs', modelId: 'r1' }, 'd1');

    await tm().processMessage(created());

    expect(mqState.published).toHaveLength(1);
    expect(mqState.published[0].message.deviceIds).toEqual([ 'd1' ]);
    expect(mqState.published[0].message.data.metadata.channels.sort())
      .toEqual([ appChannel, idChannel ].sort());
  });

  it('publishes to each transport queue the matched devices live on', async () => {
    loadApp();

    await subscribe({ appId: 'app1', model: 'runs' }, 'd1', T1);
    await subscribe({ appId: 'app1', model: 'runs' }, 'd2', T2);

    await tm().processMessage(created());

    expect(onQueue(T1).map(m => m.message.deviceIds)).toEqual([ [ 'd1' ] ]);
    expect(onQueue(T2).map(m => m.message.deviceIds)).toEqual([ [ 'd2' ] ]);
  });

  it('notifies a filtered subscriber when the new model matches its filter', async () => {
    loadApp();

    const filter = filterOn({ status: 'active' });
    const filteredKey = await subscribe({ appId: 'app1', model: 'runs', filter }, 'd1');

    await tm().processMessage(created({ status: 'active' }));

    expect(mqState.published).toHaveLength(1);
    expect(mqState.published[0].message.data.metadata.channels).toEqual([ filteredKey ]);
    expect(filteredKey).toMatch(/:filter:[0-9a-f]{16}$/);
  });

  it('skips a filtered subscriber when the new model does not match its filter', async () => {
    loadApp();

    await subscribe({ appId: 'app1', model: 'runs', filter: filterOn({ status: 'archived' }) }, 'd1');

    await tm().processMessage(created({ status: 'active' }));

    expect(mqState.published).toHaveLength(0);
  });

  it('skips a scope pattern that has no entry in the scope registry', async () => {
    loadApp();

    const appChannel = await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    await subscribe({ appId: 'app1', model: 'runs', modelId: 'r1' }, 'd2');

    // Drop just the `id:r1` scope. Its devices are still in Redis, but the TM
    // must not go looking for them.
    await h.redisClient.hDel(scopeRegistryKey(), 'id:r1');

    await tm().processMessage(created());

    expect(mqState.published).toHaveLength(1);
    expect(mqState.published[0].message.deviceIds).toEqual([ 'd1' ]);
    expect(mqState.published[0].message.data.metadata.channels).toEqual([ appChannel ]);
  });

  it('does not resolve the model schema for a channel with no filtered subscriber', async () => {
    const app = loadApp();
    const spy = vi.spyOn(app, 'getAppModelSchema');

    await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    await tm().processMessage(created());

    expect(mqState.published).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves the model schema once, however many filters it has to compile', async () => {
    const app = loadApp();
    const spy = vi.spyOn(app, 'getAppModelSchema');

    await subscribe({ appId: 'app1', model: 'runs', filter: filterOn({ status: 'active' }) }, 'd1');
    await subscribe({ appId: 'app1', model: 'runs', filter: filterOn({ count: 5 }) }, 'd2');
    await subscribe({ appId: 'app1', model: 'runs', modelId: 'r1', filter: filterOn({ status: 'active' }) }, 'd3');

    await tm().processMessage(created());

    expect(mqState.published).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('NexxusTransportManagerWorker model_updated', () => {
  it('publishes the hoisted model identity, the patch ops and the post-update version', async () => {
    loadApp();

    const channelKey = await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    await tm().processMessage(updated());

    expect(mqState.published[0].queue).toBe(T1);
    expect(mqState.published[0].message).toEqual({
      event: 'device_message',
      deviceIds: [ 'd1' ],
      data: {
        event: 'model_updated',
        model: { id: 'r1', type: 'runs', appId: 'app1', userId: undefined, version: 7 },
        patches: [ { op: 'replace', path: [ 'title' ], value: [ 'new title' ] } ],
        metadata: { channels: [ channelKey ] },
      },
    });
  });

  it('strips per-patch metadata from the published patch list', async () => {
    loadApp();
    await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    await tm().processMessage(updated([
      patch(),
      patch({ op: 'incr', path: [ 'count' ], value: [ 2 ] }),
    ]));

    const { patches } = mqState.published[0].message.data;

    expect(patches).toHaveLength(2);

    for (const p of patches) {
      expect(p).not.toHaveProperty('metadata');
      expect(Object.keys(p).sort()).toEqual([ 'op', 'path', 'value' ]);
    }
  });

  it('matches a filtered subscription when ANY patch\'s partial model matches', async () => {
    loadApp();

    const filteredKey = await subscribe(
      { appId: 'app1', model: 'runs', filter: filterOn({ status: 'archived' }) }, 'd1'
    );

    await tm().processMessage(updated([
      patch({ path: [ 'title' ], value: [ 'x' ] }, { status: 'active' }),
      patch({ path: [ 'status' ], value: [ 'archived' ] }, { status: 'archived' }),
    ]));

    expect(mqState.published).toHaveLength(1);
    expect(mqState.published[0].message.data.metadata.channels).toEqual([ filteredKey ]);
  });

  it('reuses one identity and patch list across recipients on different channels', async () => {
    loadApp();

    await subscribe({ appId: 'app1', model: 'runs' }, 'd1');
    await subscribe({ appId: 'app1', model: 'runs', modelId: 'r1' }, 'd2');

    await tm().processMessage(updated());

    const messages = onQueue(T1);

    expect(messages).toHaveLength(2);
    expect(messages[0].message.data.model).toEqual(messages[1].message.data.model);
    expect(messages[0].message.data.patches).toEqual(messages[1].message.data.patches);
    expect(messages[0].message.data.metadata.channels)
      .not.toEqual(messages[1].message.data.metadata.channels);
  });

  it('carries the userId through to the channel scope and the model identity', async () => {
    loadApp({ auth: true });

    const userChannel = await subscribe({ appId: 'app1', model: 'runs', userId: 'u1' }, 'd1');

    await tm().processMessage(updated([ patch({}, {}, { userId: 'u1' }) ]));

    expect(mqState.published).toHaveLength(1);
    expect(mqState.published[0].message.data.model).toMatchObject({ userId: 'u1' });
    expect(mqState.published[0].message.data.metadata.channels).toEqual([ userChannel ]);
  });

  it('warns and publishes nothing when the app is not loaded', async () => {
    await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    await tm().processMessage(updated());

    expect(logger.has('warning', /Application not found for appId: "app1"/)).toBe(true);
    expect(mqState.published).toHaveLength(0);
  });
});

describe('NexxusTransportManagerWorker model_deleted', () => {
  it('publishes the deleted model\'s identity to its subscribers', async () => {
    loadApp();

    const channelKey = await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    await tm().processMessage(deleted());

    expect(mqState.published).toHaveLength(1);
    expect(mqState.published[0].message).toEqual({
      event: 'device_message',
      deviceIds: [ 'd1' ],
      data: {
        event: 'model_deleted',
        model: { id: 'r1', appId: 'app1', type: 'runs' },
        metadata: { channels: [ channelKey ] },
      },
    });
  });

  it('notifies a filtered subscriber whose filter only reads identity fields', async () => {
    loadApp({ auth: true });

    const filteredKey = await subscribe(
      { appId: 'app1', model: 'runs', filter: filterOn({ userId: 'u1' }, { auth: true }) }, 'd1'
    );

    await tm().processMessage(deleted({ userId: 'u1' }));

    expect(mqState.published).toHaveLength(1);
    expect(mqState.published[0].message.data.metadata.channels).toEqual([ filteredKey ]);
  });

  it('cannot notify a filtered subscriber whose filter reads a field a delete does not carry', async () => {
    loadApp();

    // Documented gap: a delete payload carries identity fields only, so a
    // filter on `status` has nothing to match against and the subscriber is
    // never told the object it was watching is gone.
    await subscribe({ appId: 'app1', model: 'runs', filter: filterOn({ status: 'active' }) }, 'd1');

    await tm().processMessage(deleted());

    expect(mqState.published).toHaveLength(0);
  });
});

describe('NexxusTransportManagerWorker publish resilience', () => {
  it('logs and swallows a transport publish failure', async () => {
    loadApp();

    await subscribe({ appId: 'app1', model: 'runs' }, 'd1');
    vi.spyOn(h.mq, 'publishMessage').mockRejectedValueOnce(new Error('broker down'));

    await expect(tm().processMessage(created())).resolves.toBeUndefined();

    // Fan-out publishes are deliberately not awaited (throughput over
    // per-device confirmation), so the swallowed failure lands a tick later.
    await new Promise(resolve => setImmediate(resolve));

    expect(logger.has('warning',
      new RegExp(`Publish to "${T1}" failed for event "device_message" ; non-fatal: broker down`))).toBe(true);
  });

  it('does not wait for a slow transport before returning', async () => {
    loadApp();

    await subscribe({ appId: 'app1', model: 'runs' }, 'd1');

    let released: () => void = () => {};

    vi.spyOn(h.mq, 'publishMessage').mockImplementationOnce(
      () => new Promise<void>(resolve => { released = resolve; })
    );

    await expect(tm().processMessage(created())).resolves.toBeUndefined();

    released();
  });
});
