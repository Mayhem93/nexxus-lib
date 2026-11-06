import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NexxusVolatileTransportWorker, NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { NexxusDevice, NexxusRedisSubscription } from '@mayhem93/nexxus-redis';
import { NexxusApplication, NexxusToken, InvalidTokenException, SessionEndedException, FatalErrorException } from '@mayhem93/nexxus-core-lib';
import { makeHarness, logger, mqState, resetWorkerStatics, type WorkerHarness } from './harness';

class FakeVolatile extends NexxusVolatileTransportWorker<any> {
  protected queueName: any = 'websockets-transport';
  protected nodeRole = 'websockets-transport';

  /** Every `disconnectDevice` call, in order. */
  public disconnected: Array<[ string, string ]> = [];
  /** The reason of every `disconnectAllDevices` call, in order. */
  public disconnectedAll: string[] = [];

  protected async initTransport(): Promise<void> {}
  protected async sendToDevice(): Promise<void> {}
  protected async disconnectDevice(deviceId: string, reason: string): Promise<void> {
    this.disconnected.push([ deviceId, reason ]);
  }
  protected stopAcceptingConnections(): void {}
  protected async disconnectAllDevices(reason: string): Promise<void> {
    this.disconnectedAll.push(reason);
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

/**
 * Seed a device document in the in-memory redis so NexxusDevice ops work. It
 * has a live session unless told otherwise; registering refuses one whose
 * session has ended.
 */
const seedDevice = (id: string, over: Record<string, unknown> = {}) => {
  h.redisClient.store.set(NexxusDevice.getKey(id), {
    type: 'json',
    value: {
      id, appId: 'app1', name: 'D', type: 'unknown', transport: 'tq', subscriptions: [],
      session: { hash: 'h', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      ...over,
    },
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

  /**
   * Every connection has to be torn down while Redis is still up, and none may
   * arrive after the others have been ended: either way a device would stay
   * routed to a node that is gone.
   */
  it('stops taking connections, stops consuming and ends every connection before the slot queue and Redis go', async () => {
    const w = await build();

    await w.any().beforeConsume();

    const steps: string[] = [];

    vi.spyOn(w.any(), 'stopAcceptingConnections').mockImplementation(() => { steps.push('stop accepting'); });
    // Once: the base shutdown stops consuming again, which is a no-op by then.
    vi.spyOn(h.mq, 'stopConsuming').mockImplementationOnce(async () => { steps.push('stop consuming'); });
    vi.spyOn(w.any(), 'disconnectAllDevices').mockImplementation(async (reason: any) => { steps.push(`end connections: ${reason}`); });
    vi.spyOn(h.mq, 'deleteQueue').mockImplementation(async () => { steps.push('delete slot queue'); });
    vi.spyOn(h.redis, 'close').mockImplementation(async () => { steps.push('close redis'); });

    await w.close();

    expect(steps).toEqual([
      'stop accepting',
      'stop consuming',
      'end connections: service_restart',
      'delete slot queue',
      'close redis',
    ]);
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

describe('NexxusVolatileTransportWorker losing the message queue', () => {
  /** Lets the resume that a service reconnecting starts run its course. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));

  /** A worker holding slot 0, with every service up and the first resume done. */
  const running = async (): Promise<FakeVolatile> => {
    const w = await build();

    await w.any().beforeConsume();
    h.db.emit('connect');
    h.redis.emit('connect');
    await settle();

    return w;
  };

  it('ends every connection when the message-queue connection drops, and reports the slot queue lost', async () => {
    const w = await running();

    h.mq.emit('disconnect');

    expect(w.disconnectedAll).toEqual([ 'service_restart' ]);
    expect(w.any().isSlotQueueLost).toBe(true);
    expect(logger.has('warning', /Slot queue websockets-transport_0 went with the message-queue connection/)).toBe(true);
  });

  it('ignores other services, and a message-queue drop before the slot queue exists', async () => {
    const w = await build();

    h.db.emit('connect');
    h.redis.emit('connect');
    h.mq.emit('disconnect');
    h.mq.emit('connect');
    await settle();

    await w.any().beforeConsume();
    h.redis.emit('disconnect');

    expect(w.disconnectedAll).toEqual([]);
    expect(w.any().isSlotQueueLost).toBe(false);
  });

  it('declares the slot queue again before consuming resumes from it', async () => {
    const w = await running();
    const steps: string[] = [];

    h.mq.emit('disconnect');

    vi.spyOn(h.mq, 'createVolatileQueue').mockImplementation(async (name: string) => { steps.push(`declare ${name}`); });
    vi.spyOn(h.mq, 'resumeConsuming').mockImplementation(async () => { steps.push('resume'); });

    h.mq.emit('connect');

    await vi.waitFor(() => expect(steps).toEqual([ 'declare websockets-transport_0', 'resume' ]));
    expect(w.any().isSlotQueueLost).toBe(false);
    expect(logger.has('info', /Declared slot queue websockets-transport_0 again/)).toBe(true);
  });

  it('is fatal when another worker took the slot meanwhile', async () => {
    const w = await running();
    const resume = vi.spyOn(h.mq, 'resumeConsuming');
    const failed = new Promise<Error>(resolve => w.any().on('error', resolve));

    h.mq.emit('disconnect');
    mqState.queueExistsResult = true; // the other worker's queue, by our slot's name

    h.mq.emit('connect');

    const err = await failed;

    expect(err).toBeInstanceOf(FatalErrorException);
    expect(err.message).toMatch(/Can't get slot queue websockets-transport_0 back: .*another worker took the slot/);
    expect(resume).not.toHaveBeenCalled();
    expect(w.any().isSlotQueueLost).toBe(true);
  });

  /**
   * A connection lost again mid-declaration fails it, or makes the queue look
   * taken. Neither means the slot is gone: the reconnect tries again.
   */
  it('tries again on the next reconnect when the connection drops while declaring', async () => {
    const w = await running();
    const onError = vi.fn();

    w.any().on('error', onError);
    h.mq.emit('disconnect');

    vi.spyOn(h.mq, 'createVolatileQueue').mockImplementationOnce(async () => {
      h.mq.emit('disconnect');

      throw new Error('channel closed');
    });

    h.mq.emit('connect');
    await settle();

    expect(onError).not.toHaveBeenCalled();
    expect(w.any().isSlotQueueLost).toBe(true);
    // Already lost: the second drop ends no more connections.
    expect(w.disconnectedAll).toEqual([ 'service_restart' ]);

    h.mq.emit('connect');

    await vi.waitFor(() => expect(w.any().isSlotQueueLost).toBe(false));
    expect(onError).not.toHaveBeenCalled();
  });

  it('leaves a slot queue it lost alone on shutdown', async () => {
    const w = await running();

    h.mq.emit('disconnect');
    await w.close();

    expect(mqState.deletedQueues).toEqual([]);
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

  /**
   * `authenticateDevice` saw the session alive; a logout ending it before the
   * device goes online must still keep it offline, or the logout would miss the
   * new connection.
   */
  it('refuses a device whose session ends while it registers', async () => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1', { transport: null, status: 'offline' });

    // The logout, landing just before the device goes online.
    h.redisClient.beforeEval = () => {
      h.redisClient.beforeEval = null;
      delete (h.redisClient.store.get(NexxusDevice.getKey('d1')) as { value: any }).value.session;
    };

    await expect(w.any().registerDevice('d1')).rejects.toThrow(SessionEndedException);

    const stored = (h.redisClient.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;

    expect(stored).toMatchObject({ status: 'offline', transport: null });
  });

  it('marks a device offline and clears its transport on unregister', async () => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1', { transport: 'websockets-transport_0', status: 'online' });

    await w.any().unregisterDevice('d1');

    const stored = (h.redisClient.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;

    expect(stored.status).toBe('offline');
    expect(stored.transport).toBeNull();
  });

  /**
   * A connection here that closes after its device has registered on another
   * node must not undo that registration.
   */
  it('leaves a device that has registered on another transport since alone on unregister', async () => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1', { transport: 'websockets-transport_7', status: 'online' });

    await w.any().unregisterDevice('d1');

    const stored = (h.redisClient.store.get(NexxusDevice.getKey('d1')) as { value: any }).value;

    expect(stored.status).toBe('online');
    expect(stored.transport).toBe('websockets-transport_7');
  });

  /**
   * A node that crashed never tore its connections down. A device that
   * reconnects elsewhere has to be able to subscribe again; the leftovers
   * would otherwise make that a no-op that adds no route here.
   */
  it('clears what a previous connection left before registering, so the device can subscribe again', async () => {
    const w = await build();
    const sub = () => new NexxusRedisSubscription({ appId: 'app1', model: 'runs' });

    await w.any().beforeConsume();
    seedDevice('d1', { transport: 'websockets-transport_7', status: 'online', subscriptions: [ sub().getKey() ] });
    await sub().addDevice('d1', 'websockets-transport_7');

    await w.any().registerDevice('d1');

    expect(await sub().getAllDevices()).toEqual(new Set());

    const device = await NexxusDevice.get('d1', true);

    expect(device.getValue()).toMatchObject({ transport: 'websockets-transport_0', subscriptions: [] });
    expect(await device.addSubscription(sub())).toBe(true);
    expect(await sub().getAllDevices()).toEqual(new Set([ 'd1|websockets-transport_0' ]));
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
