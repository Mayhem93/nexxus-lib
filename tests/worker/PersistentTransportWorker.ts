import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusPersistentTransportWorker, NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { NexxusDevice, NexxusRedisSubscription } from '@mayhem93/nexxus-redis';
import { SessionEndedException } from '@mayhem93/nexxus-core-lib';
import { makeHarness, mqState, resetWorkerStatics, type WorkerHarness } from './harness';

/**
 * Persistent transports deliberately do NOT override beforeConsume — they share
 * one queue as competing consumers — so this fake also exercises the base's
 * default no-op hook.
 */
class FakePersistent extends NexxusPersistentTransportWorker<any> {
  protected queueName: any = 'apns-transport';
  protected nodeRole = 'apns-transport';

  protected async initTransport(): Promise<void> {}
  protected async sendToConnection(): Promise<void> {}

  public any(): any { return this; }
}

const workers: FakePersistent[] = [];
let h: WorkerHarness;

beforeEach(async () => {
  resetWorkerStatics(NexxusBaseWorker);
  h = await makeHarness();
});

afterEach(async () => {
  for (const w of workers) await w.close().catch(() => {});
  workers.length = 0;
});

const worker = (): FakePersistent => {
  const w = new FakePersistent(h.services);

  workers.push(w);

  return w;
};

/** A device with a live session unless told otherwise, as signing in leaves it. */
const seedDevice = (id: string, over: Record<string, unknown> = {}) => {
  h.redisClient.store.set(NexxusDevice.getKey(id), {
    type: 'json',
    value: {
      id, appId: 'app1', name: 'D', connections: {},
      session: { hash: 'h', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      ...over,
    },
  } as never);
};

const storedDevice = (id: string): any => (h.redisClient.store.get(NexxusDevice.getKey(id)) as { value: any }).value;

describe('NexxusPersistentTransportWorker', () => {
  it('consumes from the shared (un-suffixed) queue — no slot picking', async () => {
    const w = worker();

    await w.init();

    expect(w.any().queueName).toBe('apns-transport');
    expect(mqState.consumed[0].queue).toBe('apns-transport');
    expect(mqState.createdQueues).toEqual([]); // no per-slot queue declared
  });

  it('opens a persistent connection on the shared queue, its id being the push token', async () => {
    const w = worker();

    seedDevice('d1');

    await w.any().registerConnection('d1', 'push-token-1');

    expect(storedDevice('d1').connections['push-token-1']).toMatchObject({
      transport: 'apns-transport', type: 'persistent', subscriptions: [],
    });
  });

  it('refuses a connection for a device whose session has ended', async () => {
    const w = worker();

    seedDevice('d1', { session: undefined });

    await expect(w.any().registerConnection('d1', 'push-token-1')).rejects.toThrow(SessionEndedException);
    expect(storedDevice('d1').connections).toEqual({});
  });

  it('tears the connection of a token the push service gave up on down', async () => {
    const w = worker();
    const sub = new NexxusRedisSubscription({ appId: 'app1', model: 'runs' });

    seedDevice('d1');
    await w.any().registerConnection('d1', 'push-token-1');
    await NexxusDevice.addSubscription('d1', 'push-token-1', sub);

    await w.any().unregisterConnection('d1', 'push-token-1');

    expect(storedDevice('d1').connections).toEqual({});
    expect(await sub.getAllDevices()).toEqual(new Set());
  });
});
