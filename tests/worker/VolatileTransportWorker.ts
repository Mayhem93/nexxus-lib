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
  /** Every `disconnectConnection` call, in order. */
  public disconnectedConnections: Array<[ string, string, string ]> = [];
  /** The reason of every `disconnectAllDevices` call, in order. */
  public disconnectedAll: string[] = [];
  /** The connections this node holds, as far as the base can tell. */
  public held = new Set<string>();

  protected holdsConnection(connectionId: string): boolean {
    return this.held.has(connectionId);
  }

  protected async initTransport(): Promise<void> {}
  protected async sendToConnection(): Promise<void> {}
  protected async disconnectDevice(deviceId: string, reason: string): Promise<void> {
    this.disconnected.push([ deviceId, reason ]);
  }
  protected async disconnectConnection(deviceId: string, connectionId: string, reason: string): Promise<void> {
    this.disconnectedConnections.push([ deviceId, connectionId, reason ]);
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

  // Some tests spy on NexxusDevice's statics, which every suite shares.
  vi.restoreAllMocks();
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
      id, appId: 'app1', name: 'D', connections: {},
      session: { hash: 'h', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      ...over,
    },
  } as never);
};

/** The stored document of device `id`. */
const storedDevice = (id: string): any => (h.redisClient.store.get(NexxusDevice.getKey(id)) as { value: any }).value;

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

describe('NexxusVolatileTransportWorker connections', () => {
  const sub = () => new NexxusRedisSubscription({ appId: 'app1', model: 'runs' });

  it('opens a volatile connection on its transport queue, with no subscriptions', async () => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1');

    await w.any().registerConnection('d1', 'c1');

    expect(storedDevice('d1').connections.c1).toEqual({
      transport: 'websockets-transport_0', type: 'volatile', subscriptions: [], connectedAt: expect.any(String),
    });
    expect(storedDevice('d1').lastSeen).toBe(storedDevice('d1').connections.c1.connectedAt);
  });

  /**
   * `authenticateDevice` saw the session alive; a logout ending it before the
   * connection opens must still keep it closed, or the logout would miss it.
   */
  it('refuses a connection whose session ends while it registers', async () => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1');

    // The logout, landing just before the connection opens.
    h.redisClient.beforeEval = () => {
      h.redisClient.beforeEval = null;
      delete storedDevice('d1').session;
    };

    await expect(w.any().registerConnection('d1', 'c1')).rejects.toThrow(SessionEndedException);

    expect(storedDevice('d1').connections).toEqual({});
  });

  it('tears down only its own connection on unregister', async () => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1');
    await w.any().registerConnection('d1', 'c1');
    await w.any().registerConnection('d1', 'c2');
    await NexxusDevice.addSubscription('d1', 'c1', sub());
    await NexxusDevice.addSubscription('d1', 'c2', sub());

    await w.any().unregisterConnection('d1', 'c1');

    expect(Object.keys(storedDevice('d1').connections)).toEqual([ 'c2' ]);
    expect(await sub().getAllDevices()).toEqual(new Set([ 'd1|websockets-transport_0|c2' ]));
  });

  it('leaves a connection that is already torn down alone on unregister', async () => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1');

    await w.any().unregisterConnection('d1', 'c1');

    expect(logger.has('debug', /Connection "c1" of device "d1" was already torn down/)).toBe(true);
  });

  /**
   * A node that crashed never tore its connections down. Whatever they left,
   * a new connection starts with no subscriptions, so subscribing adds its
   * route.
   */
  it('subscribes a new connection even when a crashed one left routes behind', async () => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1', {
      connections: { c0: { transport: 'websockets-transport_7', type: 'volatile', subscriptions: [ sub().getKey() ], connectedAt: 'x' } },
    });
    await sub().addConnection('d1', 'websockets-transport_7', 'c0');

    await w.any().registerConnection('d1', 'c1');
    await NexxusDevice.addSubscription('d1', 'c1', sub());

    expect(await sub().getAllDevices()).toContain('d1|websockets-transport_0|c1');
  });
});

/**
 * One process consumes a slot queue at a time and holds every connection on
 * it, so a connection on this node's queue that it doesn't hold is dead: a
 * crashed process on the same slot left it, or its own teardown failed.
 */
describe('NexxusVolatileTransportWorker dead connections', () => {
  const sub = () => new NexxusRedisSubscription({ appId: 'app1', model: 'runs' });
  const entry = (transport: string) => ({ transport, type: 'volatile', subscriptions: [ sub().getKey() ], connectedAt: 'x' });

  /** A worker on slot 0, and device `d1` with `connections`, each routed on `runs`. */
  const withConnections = async (connections: Record<string, string>): Promise<FakeVolatile> => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1', { connections: Object.fromEntries(Object.entries(connections).map(([ id, transport ]) => [ id, entry(transport) ])) });

    for (const [ id, transport ] of Object.entries(connections)) {
      await sub().addConnection('d1', transport, id);
    }

    return w;
  };

  it('tears down, in the background, a connection on its queue that it doesn\'t hold', async () => {
    const w = await withConnections({ dead: 'websockets-transport_0' });

    w.any().tearDownDeadConnection('d1', 'dead');

    await vi.waitFor(() => expect(storedDevice('d1').connections).toEqual({}));
    expect(await sub().getAllDevices()).toEqual(new Set());
    expect(logger.has('info', /Tore down connection "dead" of device "d1": it is on this node's queue, but this node doesn't hold it/)).toBe(true);
  });

  it('leaves a connection it holds alone', async () => {
    const w = await withConnections({ live: 'websockets-transport_0' });
    const close = vi.spyOn(NexxusDevice, 'closeConnection');

    w.held.add('live');
    w.any().tearDownDeadConnection('d1', 'live');

    expect(close).not.toHaveBeenCalled();
    expect(Object.keys(storedDevice('d1').connections)).toEqual([ 'live' ]);
  });

  it('tears a dead connection down once, however many times it is met meanwhile', async () => {
    const w = await withConnections({ dead: 'websockets-transport_0' });
    const close = vi.spyOn(NexxusDevice, 'closeConnection');

    w.any().tearDownDeadConnection('d1', 'dead');
    w.any().tearDownDeadConnection('d1', 'dead');
    w.any().tearDownDeadConnection('d1', 'dead');

    await vi.waitFor(() => expect(storedDevice('d1').connections).toEqual({}));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('logs a teardown that fails, and tries again the next time the connection is met', async () => {
    const w = await withConnections({ dead: 'websockets-transport_0' });

    vi.spyOn(NexxusDevice, 'closeConnection').mockRejectedValueOnce(new Error('redis down'));
    w.any().tearDownDeadConnection('d1', 'dead');

    await vi.waitFor(() => expect(logger.has('warning', /Could not tear down dead connection "dead" of device "d1": redis down/)).toBe(true));

    w.any().tearDownDeadConnection('d1', 'dead');

    await vi.waitFor(() => expect(storedDevice('d1').connections).toEqual({}));
  });

  it('tears down, at register, only the device\'s connections on its queue that it doesn\'t hold', async () => {
    const w = await withConnections({ dead: 'websockets-transport_0', live: 'websockets-transport_0', elsewhere: 'websockets-transport_9' });

    w.held.add('live');
    w.any().tearDownDeadConnections('d1', storedDevice('d1').connections);

    await vi.waitFor(() => expect(Object.keys(storedDevice('d1').connections).sort()).toEqual([ 'elsewhere', 'live' ]));
    expect([ ...await sub().getAllDevices() ].sort()).toEqual([ 'd1|websockets-transport_0|live', 'd1|websockets-transport_9|elsewhere' ]);
  });

  it('tears down the connection a client lost, wherever it is', async () => {
    const w = await withConnections({ lost: 'websockets-transport_9' });

    await w.any().releaseLostConnection('d1', 'lost');

    expect(storedDevice('d1').connections).toEqual({});
    expect(await sub().getAllDevices()).toEqual(new Set());
    expect(logger.has('info', /Tore down connection "lost" of device "d1", which its client lost/)).toBe(true);
  });

  /** A client that names a connection still open here gets it ended by its own teardown, not by this. */
  it('leaves a lost connection it still holds to its own teardown', async () => {
    const w = await withConnections({ lost: 'websockets-transport_0' });

    w.held.add('lost');
    await w.any().releaseLostConnection('d1', 'lost');

    expect(Object.keys(storedDevice('d1').connections)).toEqual([ 'lost' ]);
  });

  it('logs a lost connection it could not tear down, and lets the registration go ahead', async () => {
    const w = await withConnections({ lost: 'websockets-transport_9' });

    vi.spyOn(NexxusDevice, 'closeConnection').mockRejectedValueOnce(new Error('redis down'));

    await expect(w.any().releaseLostConnection('d1', 'lost')).resolves.toBeUndefined();
    expect(logger.has('warning', /Could not tear down connection "lost" of device "d1", which its client lost: redis down/)).toBe(true);
  });
});

/**
 * A device can hold its application's `connections.maxPerDevice` connections
 * at once. A registration that takes it over evicts the oldest, wherever they
 * are: each is torn down here, then closed, here or by the node holding it.
 */
describe('NexxusVolatileTransportWorker connection cap', () => {
  const sub = () => new NexxusRedisSubscription({ appId: 'app1', model: 'runs' });

  /** `seconds` past a fixed instant, as `connectedAt` stores it. */
  const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

  type Seeded = { transport: string; connectedAt: string; type?: string; closing?: true };

  /** A worker on slot 0, and device `d1` with `connections`, each routed on `runs`. */
  const withConnections = async (connections: Record<string, Seeded>): Promise<FakeVolatile> => {
    const w = await build();

    await w.any().beforeConsume();
    seedDevice('d1', {
      connections: Object.fromEntries(Object.entries(connections).map(([ id, { type = 'volatile', ...rest } ]) =>
        [ id, { type, subscriptions: [ sub().getKey() ], ...rest } ])),
    });

    for (const [ id, { transport } ] of Object.entries(connections)) {
      await sub().addConnection('d1', transport, id);
    }

    return w;
  };

  /**
   * What a new connection of `d1`, `new`, does once registered, with the
   * connections the registration read: those stored now.
   */
  const evictOverCap = (w: FakeVolatile, maxConnections: number, lostConnectionId?: string): void => {
    w.any().evictConnectionsOverCap(
      { deviceId: 'd1', appId: 'app1', expiresAt: 0, connections: structuredClone(storedDevice('d1').connections), maxConnections },
      'new',
      lostConnectionId
    );
  };

  /** Time for an eviction to happen, if one is going to. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  /** The queue and message of each eviction published. */
  const evictionMessages = () => mqState.published.map(({ queue, message }) => ({ queue, message }));

  it('leaves a device within its cap alone', async () => {
    const w = await withConnections({
      a: { transport: 'websockets-transport_9', connectedAt: at(1) },
      b: { transport: 'websockets-transport_0', connectedAt: at(2) },
    });
    const close = vi.spyOn(NexxusDevice, 'closeConnection');

    w.held.add('b');
    evictOverCap(w, 3);
    await settle();

    expect(close).not.toHaveBeenCalled();
    expect(mqState.published).toEqual([]);
    expect(w.disconnectedConnections).toEqual([]);
  });

  it('evicts the oldest connections over the cap, wherever they are', async () => {
    const w = await withConnections({
      newest: { transport: 'websockets-transport_9', connectedAt: at(3) },
      oldest: { transport: 'websockets-transport_9', connectedAt: at(1) },
      here: { transport: 'websockets-transport_0', connectedAt: at(2) },
    });

    w.held.add('here');
    // Three, and the new one: two over.
    evictOverCap(w, 2);

    await vi.waitFor(() => expect(Object.keys(storedDevice('d1').connections)).toEqual([ 'newest' ]));
    expect(await sub().getAllDevices()).toEqual(new Set([ 'd1|websockets-transport_9|newest' ]));
    // The one here is closed directly; the other through its node's queue.
    await vi.waitFor(() => expect(w.disconnectedConnections).toEqual([ [ 'd1', 'here', 'evicted' ] ]));
    await vi.waitFor(() => expect(evictionMessages()).toEqual([ {
      queue: 'websockets-transport_9',
      message: { event: 'connection_evicted', connections: [ { deviceId: 'd1', connectionId: 'oldest' } ] },
    } ]));
    expect(logger.has('info', /Device "d1" is over its cap of 2 connection\(s\); evicting the 2 oldest/)).toBe(true);
  });

  /**
   * Its entry may be in what the registration read, and may look oldest, with
   * its node's clock behind the others'.
   */
  it('never evicts the connection that registered', async () => {
    const w = await withConnections({
      new: { transport: 'websockets-transport_0', connectedAt: at(1) },
      other: { transport: 'websockets-transport_9', connectedAt: at(2) },
    });

    w.held.add('new');
    evictOverCap(w, 1);

    await vi.waitFor(() => expect(Object.keys(storedDevice('d1').connections)).toEqual([ 'new' ]));
    expect(w.disconnectedConnections).toEqual([]);
  });

  it('evicts, of two that opened at once, the one with the lower id', async () => {
    const w = await withConnections({
      y: { transport: 'websockets-transport_9', connectedAt: at(1) },
      x: { transport: 'websockets-transport_9', connectedAt: at(1) },
    });

    evictOverCap(w, 2);

    await vi.waitFor(() => expect(Object.keys(storedDevice('d1').connections)).toEqual([ 'y' ]));
  });

  /**
   * By the time a connection is closed, it is gone from Redis. Its node may
   * have crashed, and never get the message: the connection is torn down
   * anyway.
   */
  it('tears an evicted connection down before closing it', async () => {
    const w = await withConnections({
      far: { transport: 'websockets-transport_9', connectedAt: at(1) },
      near: { transport: 'websockets-transport_0', connectedAt: at(2) },
    });
    const storedWhenClosed: Array<[ string, boolean ]> = [];

    w.held.add('near');
    vi.spyOn(w.any(), 'disconnectConnection').mockImplementation(async (_deviceId: any, connectionId: any) => {
      storedWhenClosed.push([ connectionId, connectionId in storedDevice('d1').connections ]);
    });
    vi.spyOn(h.mq, 'publishMessage').mockImplementation(async (_queue: any, message: any) => {
      for (const { connectionId } of message.connections) {
        storedWhenClosed.push([ connectionId, connectionId in storedDevice('d1').connections ]);
      }
    });

    evictOverCap(w, 1);

    await vi.waitFor(() => expect(storedWhenClosed).toHaveLength(2));
    expect(storedWhenClosed.sort()).toEqual([ [ 'far', false ], [ 'near', false ] ]);
  });

  it('sends one message to each queue it evicts connections on', async () => {
    const w = await withConnections({
      a: { transport: 'websockets-transport_9', connectedAt: at(1) },
      b: { transport: 'websockets-transport_9', connectedAt: at(2) },
      c: { transport: 'websockets-transport_5', connectedAt: at(3) },
    });

    evictOverCap(w, 1);

    await vi.waitFor(() => expect(mqState.published).toHaveLength(2));

    const evictedOn = Object.fromEntries(evictionMessages().map(({ queue, message }) =>
      [ queue, message.connections.map(({ connectionId }: any) => connectionId).sort() ]));

    expect(evictedOn).toEqual({ 'websockets-transport_9': [ 'a', 'b' ], 'websockets-transport_5': [ 'c' ] });
  });

  /**
   * A cap of one, so whatever counts besides the new connection is evicted.
   * Being torn down already, dead here, lost by its client, or a push
   * connection: none of these count, so only `live` goes.
   */
  it('counts neither connections being torn down, dead ones, the one the client lost, nor push connections', async () => {
    const w = await withConnections({
      dead: { transport: 'websockets-transport_0', connectedAt: at(1) },
      closing: { transport: 'websockets-transport_9', connectedAt: at(2), closing: true },
      lost: { transport: 'websockets-transport_9', connectedAt: at(3) },
      push: { transport: 'push-transport', connectedAt: at(4), type: 'persistent' },
      live: { transport: 'websockets-transport_9', connectedAt: at(5) },
    });

    evictOverCap(w, 1, 'lost');

    await vi.waitFor(() => expect(evictionMessages()).toEqual([ {
      queue: 'websockets-transport_9',
      message: { event: 'connection_evicted', connections: [ { deviceId: 'd1', connectionId: 'live' } ] },
    } ]));
    expect(Object.keys(storedDevice('d1').connections).sort()).toEqual([ 'closing', 'dead', 'lost', 'push' ]);
  });

  /** One this node still holds is live, whatever its client says. */
  it('counts a lost connection this node still holds', async () => {
    const w = await withConnections({ lost: { transport: 'websockets-transport_0', connectedAt: at(1) } });

    w.held.add('lost');
    evictOverCap(w, 1, 'lost');

    await vi.waitFor(() => expect(w.disconnectedConnections).toEqual([ [ 'd1', 'lost', 'evicted' ] ]));
  });

  /** Whatever tore it down closes it, or it closed on its own. */
  it('closes only the connections it tore down', async () => {
    const w = await withConnections({
      far: { transport: 'websockets-transport_9', connectedAt: at(1) },
      near: { transport: 'websockets-transport_0', connectedAt: at(2) },
    });
    const close = vi.spyOn(NexxusDevice, 'closeConnection').mockResolvedValue(false);

    w.held.add('near');
    evictOverCap(w, 1);

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    await settle();
    expect(mqState.published).toEqual([]);
    expect(w.disconnectedConnections).toEqual([]);
  });

  it('logs a connection it could not evict, and evicts the others', async () => {
    const w = await withConnections({
      a: { transport: 'websockets-transport_9', connectedAt: at(1) },
      b: { transport: 'websockets-transport_9', connectedAt: at(2) },
    });
    const close = NexxusDevice.closeConnection.bind(NexxusDevice);

    vi.spyOn(NexxusDevice, 'closeConnection').mockImplementation(async (deviceId, connectionId) => {
      if (connectionId === 'a') {
        throw new Error('redis down');
      }

      return close(deviceId, connectionId);
    });

    evictOverCap(w, 1);

    await vi.waitFor(() => expect(mqState.published).toHaveLength(1));
    expect(mqState.published[0].message.connections).toEqual([ { deviceId: 'd1', connectionId: 'b' } ]);
    expect(logger.has('warning', /Could not evict connection "a" of device "d1": redis down/)).toBe(true);
  });

  /** The connection is torn down all the same: nothing is routed to it, even if it stays open. */
  it('logs an eviction message the broker refuses', async () => {
    const w = await withConnections({ far: { transport: 'websockets-transport_9', connectedAt: at(1) } });

    vi.spyOn(h.mq, 'publishMessage').mockRejectedValue(new Error('broker down'));
    evictOverCap(w, 1);

    await vi.waitFor(() => expect(logger.has('error', /Publish to "websockets-transport_9" failed for event "connection_evicted"/)).toBe(true));
    expect(storedDevice('d1').connections).toEqual({});
  });

  it('closes every connection a connection_evicted names, as evicted', async () => {
    const w = await build();

    await w.any().processMessage({
      payload: { event: 'connection_evicted', connections: [ { deviceId: 'd1', connectionId: 'c1' }, { deviceId: 'd2', connectionId: 'c2' } ] },
    });

    expect(w.disconnectedConnections).toEqual([ [ 'd1', 'c1', 'evicted' ], [ 'd2', 'c2', 'evicted' ] ]);
  });
});

describe('NexxusVolatileTransportWorker sessions', () => {
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  /**
   * Two applications with different keys, loaded the way the worker loads them
   * at boot. `app1Over` adds to the first one.
   */
  const loadApps = (app1Over: Record<string, unknown> = {}): { app1: NexxusApplication; app2: NexxusApplication } => {
    const make = (id: string, over: Record<string, unknown> = {}): NexxusApplication => new NexxusApplication({
      id, type: 'application', signingSecret: `${id}-secret`, name: id,
      schema: { runs: { fields: { note: { type: 'string' } } } },
      ...over,
    } as never);
    const app1 = make('app1', app1Over);
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
    const { app1 } = loadApps({ connections: { maxPerDevice: 5 } });
    const token = NexxusToken.issue(app1, { appId: 'app1', deviceId: 'd1' });

    seedDevice('d1', {
      session: { hash: 'h', expiresAt: nowSeconds() + 3600 },
      connections: { c0: { transport: 'websockets-transport_0', type: 'volatile', subscriptions: [], connectedAt: 'x' } },
    });

    // The device's connections too, from the same read, and its application's cap.
    expect(await w.any().authenticateDevice(token)).toEqual({
      deviceId: 'd1', appId: 'app1', expiresAt: NexxusToken.verify(app1, token).exp,
      connections: { c0: { transport: 'websockets-transport_0', type: 'volatile', subscriptions: [], connectedAt: 'x' } },
      maxConnections: 5,
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
