import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusVolatileTransportWorker, NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';
import { NexxusApplication, NexxusToken, InvalidTokenException, SessionEndedException } from '@mayhem93/nexxus-core-lib';
import { makeHarness, logger, mqState, resetWorkerStatics, type WorkerHarness } from './harness';

class FakeVolatile extends NexxusVolatileTransportWorker<any> {
  protected queueName: any = 'websockets-transport';
  protected nodeRole = 'websockets-transport';

  /** Every `disconnectDevice` call, in order. */
  public disconnected: Array<[ string, string ]> = [];

  protected async initTransport(): Promise<void> {}
  protected async sendToDevice(): Promise<void> {}
  protected async disconnectDevice(deviceId: string, reason: string): Promise<void> {
    this.disconnected.push([ deviceId, reason ]);
  }

  public any(): any { return this; }
}

const workers: FakeVolatile[] = [];
let h: WorkerHarness;

const build = async (appConfig: Record<string, unknown> = {}): Promise<FakeVolatile> => {
  resetWorkerStatics(NexxusBaseWorker);
  h = await makeHarness(appConfig);

  const w = new FakeVolatile(h.services);

  workers.push(w);

  // `init()` has connected the queue by the time it calls `beforeConsume()`;
  // these tests call the hook directly, so they connect it themselves.
  await h.mq.connect();

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

describe('NexxusVolatileTransportWorker sessions', () => {
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  /** Two applications with different keys, loaded the way the worker loads them at boot. */
  const loadApps = (): { app1: NexxusApplication; app2: NexxusApplication } => {
    const make = (id: string): NexxusApplication => new NexxusApplication({
      id, type: 'application', signingSecret: `${id}-secret`, name: id,
      schema: { runs: { fields: { note: { type: 'string' } } } },
    } as never);
    const app1 = make('app1');
    const app2 = make('app2');

    (NexxusBaseWorker as any).loadedApps.set('app1', app1);
    (NexxusBaseWorker as any).loadedApps.set('app2', app2);

    return { app1, app2 };
  };

  it('drops every device a device_logout names, as logged out', async () => {
    const w = await build();

    await w.any().processMessage({ payload: { event: 'device_logout', deviceIds: [ 'd1', 'd2' ] } });

    expect(w.disconnected).toEqual([ [ 'd1', 'logged_out' ], [ 'd2', 'logged_out' ] ]);
  });

  it('registers a device whose session is alive, and reports what its token proves', async () => {
    const w = await build();
    const { app1 } = loadApps();
    const token = NexxusToken.issue(app1, { appId: 'app1', deviceId: 'd1' });

    seedDevice('d1', { session: { hash: 'h', expiresAt: nowSeconds() + 3600 } });

    expect(await w.any().authenticateDevice(token)).toEqual({
      deviceId: 'd1', appId: 'app1', expiresAt: NexxusToken.verify(app1, token).exp,
    });
  });

  /**
   * A device that logged out still holds an access token valid until it
   * expires. Registration is where that token stops working.
   */
  it('refuses to register a device whose session has ended or expired', async () => {
    const w = await build();
    const { app1 } = loadApps();
    const token = NexxusToken.issue(app1, { appId: 'app1', deviceId: 'd1' });

    // Its own exception, not an InvalidTokenException: the token itself is fine,
    // and the client's way out is a new session, not a new token.
    for (const session of [ undefined, { hash: 'h', expiresAt: nowSeconds() - 1 } ]) {
      seedDevice('d1', { session });

      await expect(w.any().authenticateDevice(token)).rejects.toThrow(SessionEndedException);
    }
  });

  it('accepts a refreshed token only for the device AND application the connection registered as', async () => {
    const w = await build();
    const { app1, app2 } = loadApps();
    const same = NexxusToken.issue(app1, { appId: 'app1', deviceId: 'd1' });

    expect(w.any().authenticateRefreshedToken(same, 'd1', 'app1')).toBe(NexxusToken.verify(app1, same).exp);

    // A different device, and the same device id under a different application:
    // either would let a connection become something it didn't register as.
    for (const other of [
      NexxusToken.issue(app1, { appId: 'app1', deviceId: 'd2' }),
      NexxusToken.issue(app2, { appId: 'app2', deviceId: 'd1' }),
    ]) {
      expect(() => w.any().authenticateRefreshedToken(other, 'd1', 'app1')).toThrow(InvalidTokenException);
    }
  });

  it('refreshes without touching Redis', async () => {
    const w = await build();
    const { app1 } = loadApps();

    // No device seeded at all: a refresh never looks it up.
    expect(() => w.any().authenticateRefreshedToken(
      NexxusToken.issue(app1, { appId: 'app1', deviceId: 'd1' }), 'd1', 'app1'
    )).not.toThrow();
  });
});
