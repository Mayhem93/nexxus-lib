import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusVolatileTransportWorker, NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';
import { makeHarness, logger, mqState, resetWorkerStatics, type WorkerHarness } from './harness';

class FakeVolatile extends NexxusVolatileTransportWorker<any> {
  protected queueName: any = 'websockets-transport';
  protected nodeRole = 'websockets-transport';

  protected async initTransport(): Promise<void> {}
  protected async sendToDevice(): Promise<void> {}

  public any(): any { return this; }
}

const workers: FakeVolatile[] = [];
let h: WorkerHarness;

const build = async (appConfig: Record<string, unknown> = {}): Promise<FakeVolatile> => {
  resetWorkerStatics(NexxusBaseWorker);
  h = await makeHarness(appConfig);

  const w = new FakeVolatile(h.services);

  workers.push(w);

  return w;
};

beforeEach(async () => { h = await makeHarness(); });

afterEach(async () => {
  for (const w of workers) await w.close().catch(() => {});
  workers.length = 0;
});

/** Seed a device document in the in-memory redis so NexxusDevice ops work. */
const seedDevice = (id: string, over: Record<string, unknown> = {}) => {
  h.redisClient.store.set(NexxusDevice.getKey(id), {
    type: 'json',
    value: { id, appId: 'app1', name: 'D', type: 'unknown', transport: 'tq', subscriptions: [], ...over },
  } as never);
};

describe('NexxusVolatileTransportWorker.beforeConsume — slot picking', () => {
  it('defaults to slot 0 with a warning when no Hub is configured', async () => {
    const w = await build();

    await w.any().beforeConsume();

    expect(w.any().queueName).toBe('websockets-transport_0');
    expect(mqState.createdQueues).toEqual(['websockets-transport_0']);
    expect(logger.has('warning', /No Hub configured — defaulting to slot 0/)).toBe(true);
  });

  it('picks the lowest free slot from Hub peers (gap detection)', async () => {
    const w = await build({ hub: { endpoint: 'http://hub.local', token: 't' } });

    w.any().hubClient = { listNodesByRole: async () => [{ slot: 0 }, { slot: 2 }] };

    await w.any().beforeConsume();

    expect(w.any().queueName).toBe('websockets-transport_1'); // fills the gap
    expect(logger.has('info', /Picked slot 1/)).toBe(true);
  });

  it('ignores peers without a slot number', async () => {
    const w = await build({ hub: { endpoint: 'http://hub.local', token: 't' } });

    w.any().hubClient = { listNodesByRole: async () => [{ slot: undefined }, { slot: 0 }] };

    await w.any().beforeConsume();

    expect(w.any().queueName).toBe('websockets-transport_1');
  });

  it('throws when the chosen slot queue already exists on the broker', async () => {
    const w = await build();

    mqState.queueExistsResult = true;

    await expect(w.any().beforeConsume()).rejects.toThrow(/slot 0 already taken/);
    expect(mqState.createdQueues).toEqual([]);
  });
});

describe('NexxusVolatileTransportWorker.buildHubPayload', () => {
  it('reports the slot parsed from the queue name suffix', async () => {
    const w = await build();

    await w.any().beforeConsume();

    expect((await w.any().buildHubPayload('n1')).slot).toBe(0);
  });

  it('reports no slot before a slot has been picked', async () => {
    const w = await build();

    expect((await w.any().buildHubPayload('n1')).slot).toBeUndefined();
  });
});

describe('NexxusVolatileTransportWorker.close', () => {
  it('deletes the per-slot queue so the slot is released', async () => {
    const w = await build();

    await w.any().beforeConsume();
    await w.close();

    expect(mqState.deletedQueues).toEqual(['websockets-transport_0']);
  });

  it('logs an error but still closes when the queue delete fails', async () => {
    const w = await build();

    await w.any().beforeConsume();
    mqState.deleteQueueImpl = () => { throw new Error('broker busy'); };

    await w.close();

    // Error, not warning: a slot queue left behind on the broker blocks that
    // slot for future workers, so it needs to be visible.
    expect(logger.has('error', /Failed to delete slot queue .* broker busy/)).toBe(true);
  });
});

describe('NexxusVolatileTransportWorker device registration', () => {
  it('records a volatile device as online on its transport queue', async () => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1');

    await w.any().registerDevice('d1');

    const stored = (h.redisClient.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;

    expect(stored.type).toBe('volatile');
    expect(stored.status).toBe('online');
    expect(stored.transport).toBe('websockets-transport_0');
    expect(typeof stored.lastSeen).toBe('string'); // ISO timestamp
  });

  it('marks a device offline and clears its transport on unregister', async () => {
    const w = await build();

    seedDevice('d1', { subscriptions: [] });

    await w.any().unregisterDevice('d1');

    const stored = (h.redisClient.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;

    expect(stored.status).toBe('offline');
    expect(stored.transport).toBeNull();
  });
});
