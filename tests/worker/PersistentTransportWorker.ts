import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusPersistentTransportWorker, NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';
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
  protected async sendToDevice(): Promise<void> {}

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

const seedDevice = (id: string, over: Record<string, unknown> = {}) => {
  h.redisClient.store.set(NexxusDevice.getKey(id), {
    type: 'json',
    value: { id, appId: 'app1', name: 'D', type: 'unknown', transport: 'tq', subscriptions: [], ...over },
  } as never);
};

describe('NexxusPersistentTransportWorker', () => {
  it('consumes from the shared (un-suffixed) queue — no slot picking', async () => {
    const w = worker();

    await w.init();

    expect(w.any().queueName).toBe('apns-transport');
    expect(mqState.consumed[0].queue).toBe('apns-transport');
    expect(mqState.createdQueues).toEqual([]); // no per-slot queue declared
  });

  it('records a registered device as persistent and online', async () => {
    const w = worker();

    seedDevice('d1');

    await w.any().registerDevice('d1');

    const stored = (h.redisClient.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;

    expect(stored.type).toBe('persistent');
    expect(stored.status).toBe('online');
    expect(stored.transport).toBe('apns-transport');
  });

  it('marks a device offline on unregister, preserving its transport association', async () => {
    const w = worker();

    seedDevice('d1', { transport: 'apns-transport' });

    await w.any().unregisterDevice('d1');

    const stored = (h.redisClient.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;

    expect(stored.status).toBe('offline');
    expect(stored.transport).toBe('apns-transport'); // deliberately NOT cleared
  });
});
