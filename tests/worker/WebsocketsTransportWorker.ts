/**
 * The websockets transport is tested against a REAL `ws` server and REAL `ws`
 * clients on an ephemeral port — the frames asserted here are the bytes a
 * device would actually receive. Only the services behind it (redis, database,
 * message queue) are fakes, as everywhere else in this package.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NexxusWebsocketsTransportWorker, NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { NexxusDevice, RedisDeviceInvalidParamsException } from '@mayhem93/nexxus-redis';
import { makeHarness, logger, mqState, getFreePort, resetWorkerStatics, type WorkerHarness } from './harness';

import WebSocket from 'ws';

const workers: any[] = [];
const sockets: WebSocket[] = [];
let h: WorkerHarness;
let wsPort: number;

afterEach(async () => {
  for (const s of sockets) {
    s.removeAllListeners();

    if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.terminate();
  }

  sockets.length = 0;

  for (const w of workers) await w.close().catch(() => {});
  workers.length = 0;

  vi.restoreAllMocks();
});

/** A worker with its WS server already listening on a free port. */
const build = async (): Promise<any> => {
  wsPort = await getFreePort();

  resetWorkerStatics(NexxusBaseWorker);
  h = await makeHarness({ port: wsPort });

  const w = new NexxusWebsocketsTransportWorker(h.services) as any;

  workers.push(w);

  await w.beforeConsume(); // picks slot 0 → queueName 'websockets-transport_0'
  await w.initTransport();

  return w;
};

/** Seed a device document in the in-memory redis so NexxusDevice ops resolve. */
const seedDevice = (id: string, over: Record<string, unknown> = {}) => {
  h.redisClient.store.set(NexxusDevice.getKey(id), {
    type: 'json',
    value: { id, appId: 'app1', name: 'D', type: 'unknown', subscriptions: [], ...over },
  } as never);
};

const storedDevice = (id: string): any =>
  (h.redisClient.store.get(NexxusDevice.getKey(id)) as { value: any } | undefined)?.value;

const connect = (): Promise<WebSocket> => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

  sockets.push(ws);
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
});

/** Resolves with the next frame the server sends. Attach BEFORE sending. */
const nextFrame = (ws: WebSocket): Promise<any> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), 2000);

  ws.once('message', raw => {
    clearTimeout(timer);

    try {
      resolve(JSON.parse(raw.toString()));
    } catch (e) {
      reject(e);
    }
  });
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 2000;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);

    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const register = (deviceId: unknown) => JSON.stringify({ event: 'register', data: { deviceId } });

/** Register a device end-to-end and hand back its live socket. */
const registered = async (w: any, deviceId = 'd1'): Promise<WebSocket> => {
  seedDevice(deviceId);

  const client = await connect();
  const reply = nextFrame(client);

  client.send(register(deviceId));

  expect(await reply).toEqual({ event: 'register', data: { success: true } });

  return client;
};

const CREATED = {
  event: 'model_created',
  model: { id: 'r1', appId: 'app1', type: 'runs', title: 'hello' },
  metadata: { channels: [ 'nexxus:subscription:app1:runs' ] },
} as any;

describe('NexxusWebsocketsTransportWorker.initTransport', () => {
  it('listens on the configured port and accepts a connection', async () => {
    const w = await build();

    await connect();

    expect(logger.has('info', new RegExp(`WebSocket server listening on port ${wsPort}`))).toBe(true);
    await waitFor(() => w.wsToNexxusClientMap.size === 1, 'the connection to be tracked');
    expect(logger.has('info', /New client connected with ID: "[0-9a-f-]{36}"/)).toBe(true);
  });

  it('rejects when the port is already taken', async () => {
    await build();

    resetWorkerStatics(NexxusBaseWorker);
    h = await makeHarness({ port: wsPort }); // same port, still held by the first server

    const second = new NexxusWebsocketsTransportWorker(h.services) as any;

    workers.push(second);

    await expect(second.initTransport()).rejects.toThrow(/EADDRINUSE|address already in use/i);
  });

  it('logs a server-level error raised after the bind instead of crashing', async () => {
    const w = await build();

    // Without a lasting listener this would be an unhandled 'error' event, which
    // is fatal to the process.
    w.server.emit('error', new Error('server exploded'));

    expect(logger.has('error', /WebSocket server error: server exploded/)).toBe(true);
  });
});

describe('NexxusWebsocketsTransportWorker registration', () => {
  it('registers a device and records it as online on this worker\'s slot queue', async () => {
    const w = await build();

    await registered(w);

    expect(storedDevice('d1')).toMatchObject({
      type: 'volatile',
      status: 'online',
      transport: 'websockets-transport_0',
    });
    expect(w.registeredClients.size).toBe(1);
    expect(w.unregisteredClients.size).toBe(0);
    expect(logger.has('info', /Client "[0-9a-f-]{36}" registered with device ID: "d1"/)).toBe(true);
  });

  it('rejects a deviceId that does not exist in redis', async () => {
    await build();

    const client = await connect();
    const reply = nextFrame(client);

    client.send(register('ghost'));

    expect(await reply).toEqual({
      event: 'error',
      data: { message: 'Device with ID "ghost" not found.', code: 'DEVICE_NOT_FOUND' },
    });
  });

  it('rejects a missing or blank deviceId', async () => {
    await build();

    for (const bad of [ undefined, '', '   ', 42 ]) {
      const client = await connect();
      const reply = nextFrame(client);

      client.send(register(bad));

      // `undefined` drops the key entirely, so it trips the "missing data" guard
      // on the way in rather than the deviceId check.
      expect(await reply).toMatchObject({ event: 'error', data: { code: 'INVALID_PARAMETERS' } });
    }
  });

  it('warns when an already registered client tries to register again', async () => {
    const w = await build();
    const client = await registered(w);

    client.send(register('d1'));

    await waitFor(
      () => logger.has('warning', /is already registered with device ID: "d1"/),
      'the already-registered warning'
    );
    expect(w.registeredClients.size).toBe(1);
  });

  /**
   * The client used to mark ITSELF registered before the worker's redis write,
   * and the worker listened with `once`. A transient redis failure therefore
   * bricked the connection for good: the client looked registered to itself, so
   * every retry was refused as "already registered", while the worker had no
   * route to it.
   */
  it('stays retryable when the registration write fails', async () => {
    const w = await build();

    seedDevice('d1');

    const client = await connect();

    vi.spyOn(h.redisClient.json, 'mSet').mockResolvedValueOnce(null); // → RedisCommandErrorException

    const failure = nextFrame(client);

    client.send(register('d1'));

    expect(await failure).toMatchObject({ event: 'error', data: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(w.registeredClients.size).toBe(0);
    expect(logger.has('error', /Unexpected error during client registration for device ID "d1"/)).toBe(true);

    // The retry must get through.
    const success = nextFrame(client);

    client.send(register('d1'));

    expect(await success).toEqual({ event: 'register', data: { success: true } });
    expect(w.registeredClients.size).toBe(1);
    expect(storedDevice('d1')).toMatchObject({ status: 'online' });
  });

  it('reports an invalid-parameters error when the device update is rejected', async () => {
    const w = await build();

    seedDevice('d1');

    const client = await connect();

    vi.spyOn(NexxusDevice, 'update').mockRejectedValueOnce(new RedisDeviceInvalidParamsException('bad field'));

    const reply = nextFrame(client);

    client.send(register('d1'));

    expect(await reply).toMatchObject({
      event: 'error',
      data: { message: 'Invalid parameters for device with ID "d1": bad field', code: 'INVALID_PARAMETERS' },
    });
    expect(w.registeredClients.size).toBe(0);
  });

  /** The guard that keeps `on` (rather than `once`) from opening up register spam. */
  it('refuses a second register frame while the first is still in flight', async () => {
    const w = await build();

    seedDevice('d1');

    const client = await connect();
    const frames: any[] = [];

    client.on('message', raw => frames.push(JSON.parse(raw.toString())));

    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realGet = h.redisClient.json.get.bind(h.redisClient.json);

    vi.spyOn(h.redisClient.json, 'get').mockImplementationOnce(async (...args: any[]) => {
      await gate;

      return realGet(...(args as [string]));
    });

    client.send(register('d1'));
    client.send(register('d1'));

    await waitFor(() => logger.has('warning', /already has a registration in flight/), 'the in-flight warning');

    release();

    await waitFor(() => frames.length > 0, 'the registration reply');

    expect(frames).toEqual([ { event: 'register', data: { success: true } } ]); // exactly one reply
    expect(w.registeredClients.size).toBe(1);
  });

  it('answers with an internal error when the device lookup fails outright', async () => {
    const w = await build();

    const client = await connect();

    vi.spyOn(h.redisClient.json, 'get').mockRejectedValueOnce(new Error('redis down'));

    const reply = nextFrame(client);

    client.send(register('d1'));

    expect(await reply).toEqual({
      event: 'error',
      data: {
        message: 'An unexpected error occurred while processing the message.',
        code: 'INTERNAL_SERVER_ERROR',
      },
    });
    expect(logger.has('error', /Error processing message from client "[0-9a-f-]{36}"/)).toBe(true);
    expect(w.registeredClients.size).toBe(0);
  });
});

describe('NexxusWebsocketsTransportWorker inbound frame handling', () => {
  /**
   * The frame parse used to be unguarded inside an async listener, so one
   * malformed frame from any client became an unhandled rejection and took the
   * whole worker down — every other device's live connection with it.
   */
  it('answers a non-JSON frame with an error and keeps serving', async () => {
    const w = await build();

    const client = await connect();
    const reply = nextFrame(client);

    client.send('}{ not json');

    expect(await reply).toMatchObject({ event: 'error', data: { code: 'INVALID_PARAMETERS' } });
    expect((await reply).data.message).toMatch(/Message is not valid JSON/);

    // Still alive and able to complete a real handshake.
    seedDevice('d1');

    const success = nextFrame(client);

    client.send(register('d1'));

    expect(await success).toEqual({ event: 'register', data: { success: true } });
    expect(w.registeredClients.size).toBe(1);
  });

  it('rejects a JSON frame that is not an object', async () => {
    await build();

    const client = await connect();
    const reply = nextFrame(client);

    client.send('"just a string"');

    expect(await reply).toMatchObject({
      event: 'error',
      data: { message: 'Message must be a JSON object.', code: 'INVALID_PARAMETERS' },
    });
  });

  it('rejects a frame with no event type', async () => {
    await build();

    const client = await connect();
    const reply = nextFrame(client);

    client.send(JSON.stringify({ data: { deviceId: 'd1' } }));

    expect(await reply).toMatchObject({
      event: 'error',
      data: { message: 'Missing event type in message.', code: 'INVALID_PARAMETERS' },
    });
  });

  it('rejects a frame with no data', async () => {
    await build();

    const client = await connect();
    const reply = nextFrame(client);

    client.send(JSON.stringify({ event: 'register' }));

    expect(await reply).toMatchObject({
      event: 'error',
      data: { message: 'Missing data in message.', code: 'INVALID_PARAMETERS' },
    });
  });

  it('warns about an unknown client event without answering', async () => {
    await build();

    const client = await connect();

    client.send(JSON.stringify({ event: 'teleport', data: { x: 1 } }));

    await waitFor(() => logger.has('warning', /Unknown client event: teleport/), 'the unknown-event warning');
  });

  /**
   * The backstop behind `processMessage`'s own try/catch: if even sending the
   * error reply fails (socket died mid-reply), that must be a log line and not
   * an unhandled rejection.
   */
  it('logs rather than crashing when the error reply itself fails', async () => {
    const w = await build();
    const client = await connect();

    await waitFor(() => w.wsToNexxusClientMap.size === 1, 'the connection to be tracked');

    const nxxClient = [ ...w.wsToNexxusClientMap.values() ][0];

    vi.spyOn(h.redisClient.json, 'get').mockRejectedValueOnce(new Error('redis down'));
    vi.spyOn(nxxClient, 'sendError').mockImplementation(() => { throw new Error('socket gone'); });

    client.send(register('d1'));

    await waitFor(
      () => logger.has('error', /Unhandled error processing message from client "[0-9a-f-]{36}"/),
      'the backstop log'
    );
  });

  it('survives a socket-level error', async () => {
    const w = await build();

    await connect();
    await waitFor(() => w.wsToNexxusClientMap.size === 1, 'the connection to be tracked');

    const serverWs = [ ...w.wsToNexxusClientMap.keys() ][0];

    // A ws socket with no 'error' listener throws; any client can provoke one
    // with a malformed frame or an abrupt reset.
    serverWs.emit('error', new Error('socket exploded'));

    expect(logger.has('error', /WebSocket error for client "[0-9a-f-]{36}": socket exploded/)).toBe(true);
  });
});

describe('NexxusWebsocketsTransportWorker.sendToDevice', () => {
  it('delivers a model event to the registered device over the wire', async () => {
    const w = await build();
    const client = await registered(w);

    const frame = nextFrame(client);

    await w.sendToDevice('d1', CREATED);

    expect(await frame).toEqual({ event: 'model_created', data: CREATED });
  });

  it('delivers update and delete events the same way', async () => {
    const w = await build();
    const client = await registered(w);

    for (const data of [
      { event: 'model_updated', model: { id: 'r1', version: 2 }, patches: [], metadata: { channels: [] } },
      { event: 'model_deleted', model: { id: 'r1', appId: 'app1', type: 'runs' }, metadata: { channels: [] } },
    ] as any[]) {
      const frame = nextFrame(client);

      await w.sendToDevice('d1', data);

      expect(await frame).toEqual({ event: data.event, data });
    }
  });

  it('logs and ignores a device with no live connection', async () => {
    const w = await build();

    await expect(w.sendToDevice('ghost', CREATED)).resolves.toBeUndefined();
    expect(logger.has('info', /No registered client found for device ID: "ghost"/)).toBe(true);
  });

  it('warns about an unrecognized event type in the payload', async () => {
    const w = await build();

    await registered(w);

    await w.sendToDevice('d1', { event: 'model_imploded', metadata: { channels: [] } } as any);

    expect(logger.has('warning', /Unknown event type in payload: for device ID: "d1"/)).toBe(true);
  });

  it('drops the message instead of erroring when the socket is already closing', async () => {
    const w = await build();

    await registered(w);

    const serverWs = [ ...w.wsToNexxusClientMap.keys() ][0];

    serverWs.close(); // readyState → CLOSING, synchronously

    await expect(w.sendToDevice('d1', CREATED)).resolves.toBeUndefined();
    expect(logger.entries.some(e => /Dropped a message for client .* socket is not open/.test(e.message))).toBe(true);
  });
});

describe('NexxusWebsocketsTransportWorker disconnect', () => {
  it('marks the device offline and forgets the connection', async () => {
    const w = await build();
    const client = await registered(w);

    client.close();

    await waitFor(() => w.wsToNexxusClientMap.size === 0, 'the disconnect to be handled');

    expect(w.registeredClients.size).toBe(0);
    expect(storedDevice('d1')).toMatchObject({ status: 'offline', transport: null });
    expect(logger.has('info', /disconnected with device ID: "d1/)).toBe(true);
  });

  it('forgets a client that disconnects before registering', async () => {
    const w = await build();
    const client = await connect();

    await waitFor(() => w.unregisteredClients.size === 1, 'the connection to be tracked');

    client.close();

    await waitFor(() => w.wsToNexxusClientMap.size === 0, 'the disconnect to be handled');

    expect(w.unregisteredClients.size).toBe(0);
  });

  /**
   * The local map cleanup used to sit after the awaited redis update inside the
   * same try, so a failed update leaked a client reference per disconnect and
   * drifted `totalConnections` upward permanently.
   */
  it('still cleans up its maps when the redis unregister fails', async () => {
    const w = await build();
    const client = await registered(w);

    vi.spyOn(h.redisClient.json, 'mSet').mockResolvedValue(null); // → RedisCommandErrorException

    client.close();

    await waitFor(() => w.wsToNexxusClientMap.size === 0, 'the disconnect to be handled');

    expect(w.registeredClients.size).toBe(0);
    expect(logger.has('error', /Unexpected error on client disconnect/)).toBe(true);
    expect(await w.getOwnStats()).toEqual({
      registeredClients: 0,
      unregisteredClients: 0,
      totalConnections: 0,
    });
  });

  it('reports a rejected device update on disconnect distinctly', async () => {
    const w = await build();
    const client = await registered(w);

    vi.spyOn(NexxusDevice, 'update').mockRejectedValueOnce(new RedisDeviceInvalidParamsException('bad field'));

    client.close();

    await waitFor(() => w.wsToNexxusClientMap.size === 0, 'the disconnect to be handled');

    expect(logger.has('error', /Error updating device on disconnect for device ID "d1"/)).toBe(true);
    expect(w.registeredClients.size).toBe(0);
  });

  it('ignores a close event for a connection it has already forgotten', async () => {
    const w = await build();
    const client = await registered(w);
    const serverWs = [ ...w.wsToNexxusClientMap.keys() ][0];
    const disconnectLogs = () => logger.entries.filter(e => /disconnected with device ID/.test(e.message)).length;

    client.close();

    await waitFor(() => w.wsToNexxusClientMap.size === 0, 'the disconnect to be handled');
    expect(disconnectLogs()).toBe(1);

    // A repeat 'close' for the same socket must be a no-op, not a second
    // unregister against redis.
    serverWs.emit('close', 1000, Buffer.from(''));

    await new Promise(resolve => setImmediate(resolve));

    expect(disconnectLogs()).toBe(1);
  });
});

describe('NexxusWebsocketsTransportWorker.getOwnStats', () => {
  it('counts registered, unregistered and total connections', async () => {
    const w = await build();

    await registered(w, 'd1');
    await connect(); // connected but never registered

    await waitFor(() => w.wsToNexxusClientMap.size === 2, 'both connections to be tracked');

    expect(await w.getOwnStats()).toEqual({
      registeredClients: 1,
      unregisteredClients: 1,
      totalConnections: 2,
    });
  });
});

describe('NexxusWebsocketsTransportWorker.close', () => {
  it('releases the slot queue and stops accepting connections', async () => {
    const w = await build();

    await w.close();
    workers.length = 0; // already closed; don't double-close in afterEach

    // The awaited super.close() is what deletes the per-slot queue.
    expect(mqState.deletedQueues).toEqual([ 'websockets-transport_0' ]);
    expect(logger.has('info', /WebSocket server closed/)).toBe(true);
    await expect(connect()).rejects.toThrow(/ECONNREFUSED/);
  });

  it('surfaces a failure to close the server', async () => {
    const w = await build();

    await w.close();
    workers.length = 0;

    // Second time round the ws server is already down, so its close callback
    // hands back an error rather than resolving.
    await expect(w.close()).rejects.toThrow(/not running/i);
  });
});
