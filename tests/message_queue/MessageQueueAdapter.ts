import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NexxusMessageQueueAdapter,
  NexxusMessageQueuePublishException,
  type NexxusMessageQueueConfig,
  type NexxusMessageQueueAdapterEvents,
  type NexxusMessageQueueAdapterStats,
  type NexxusQueueMessage,
  type NexxusMessageDelivery,
  type NexxusConsumeOptions,
} from '@mayhem93/nexxus-message-queue-lib';
import { NexxusBaseLogger, UnknownApplicationException, type INexxusBaseServices } from '@mayhem93/nexxus-core-lib';

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

/** Capturing logger — instanceof NexxusBaseLogger so the adapter constructor accepts it. */
class TestLogger extends NexxusBaseLogger<Record<string, unknown>> {
  public entries: Array<{ level: string; message: string }> = [];

  public log(level: string, message: string): void {
    this.entries.push({ level, message });
  }

  public async getStats(): Promise<Record<string, unknown>> {
    return {};
  }

  public has(level: string, re: RegExp): boolean {
    return this.entries.some(e => e.level === level && re.test(e.message));
  }
}

const logger = new TestLogger({});

/**
 * Fake concrete adapter: implements the broker hooks as controllable in-memory
 * behavior so the base's state machine can be exercised without a real broker.
 */
class FakeMqAdapter extends NexxusMessageQueueAdapter<
  NexxusMessageQueueConfig,
  NexxusMessageQueueAdapterEvents,
  NexxusMessageQueueAdapterStats
> {
  protected reconnectDelayMs = 5;

  // control knobs
  public onDoConnect: () => void = () => {}; // throw inside to simulate a failed attempt
  public gate: Promise<void> | null = null;  // when set, doConnect awaits it (hang-until-released)
  public failNextConsume = false;

  // call records
  public doConnectCalls = 0;
  public doDisconnectCalls = 0;
  public cancelAllCalls = 0;
  public consumeCalls: string[] = [];
  /** The `deliver` the base handed `doConsume` for each queue — how a test sends it a message. */
  public delivers: Map<string, (delivery: NexxusMessageDelivery) => void> = new Map();
  /** What the base handed `doPublish`, decoded. */
  public published: Array<{ queue: string; message: unknown; metadata?: Record<string, any> }> = [];
  /** Stands in for the broker's answer to a publish; resolves (confirms) when unset. */
  public publishImpl: (() => Promise<void>) | null = null;

  protected async doConnect(): Promise<void> {
    this.doConnectCalls += 1;

    if (this.gate) {
      await this.gate;
    }

    this.onDoConnect(); // throws → a failed attempt
  }

  protected async doDisconnect(): Promise<void> {
    this.doDisconnectCalls += 1;
  }

  protected isFatalConnectError(err: unknown): boolean {
    return (err as Error).message === 'FATAL';
  }

  protected async doConsume(queueName: string, deliver: (delivery: NexxusMessageDelivery) => void): Promise<void> {
    if (this.failNextConsume) {
      this.failNextConsume = false;

      throw new Error('doConsume boom');
    }

    this.consumeCalls.push(queueName);
    this.delivers.set(queueName, deliver);
  }

  protected async doCancelAll(): Promise<void> {
    this.cancelAllCalls += 1;
  }

  protected async doPublish(queueName: string, content: Buffer, metadata?: Record<string, any>): Promise<void> {
    if (this.publishImpl) await this.publishImpl();

    this.published.push({ queue: queueName, message: JSON.parse(content.toString()), metadata });
  }

  public getBootstrapper(): never { return undefined as never; }
  public async queueExists(): Promise<boolean> { return false; }
  public async createVolatileQueue(): Promise<void> {}
  public async deleteQueue(): Promise<void> {}
  public async getStats(): Promise<NexxusMessageQueueAdapterStats> { return { id: 'fake' }; }

  // test accessors for protected/private state
  public ser(payload: unknown): Promise<Buffer> { return this.serializePayload(payload as never); }
  public deser(buf: Buffer): Promise<unknown> { return this.deserializePayload(buf); }
  public get connectedState(): boolean { return (this as unknown as { connected: boolean }).connected; }
  public get paused(): boolean { return (this as unknown as { consumingPaused: boolean }).consumingPaused; }
  public get consumerKeys(): string[] { return [...(this as unknown as { consumers: Map<string, unknown> }).consumers.keys()]; }
  public lostConnection(): void { (this as unknown as { onConnectionLost: () => void }).onConnectionLost(); }
  public useRetryDelays(delaysMs: number[]): void { this.retryDelaysMs = delaysMs; }
}

/** A delivery as a concrete adapter builds one, recording how the base settled it. */
const fakeDelivery = (payload: unknown = { event: 'model_created' }, content?: Buffer) => {
  const delivery = {
    content: content ?? Buffer.from(JSON.stringify(payload)),
    metadata: { tag: 1 },
    live: true,
    settled: [] as string[],
    ack: (): void => { delivery.settled.push('ack'); },
    deadLetter: (): void => { delivery.settled.push('deadLetter'); },
    requeue: (): void => { delivery.settled.push('requeue'); },
    isLive: (): boolean => delivery.live,
  };

  return delivery;
};

const makeAdapter = (mqConfig: NexxusMessageQueueConfig = {}): FakeMqAdapter => {
  const services = { configManager: { getConfig: () => mqConfig }, logger } as unknown as INexxusBaseServices;

  return new FakeMqAdapter(services);
};

const adapters: FakeMqAdapter[] = [];
const track = (a: FakeMqAdapter): FakeMqAdapter => { adapters.push(a); return a; };

beforeEach(() => { logger.entries = []; });

afterEach(async () => {
  // Stop any running retry loops so timers don't leak across tests.
  for (const a of adapters) {
    await a.disconnect().catch(() => {});
  }
  adapters.length = 0;
});

describe('serializePayload / deserializePayload', () => {
  it('round-trips through JSON when compression is disabled', async () => {
    const a = track(makeAdapter({}));
    const payload = { type: 'x', value: 42 };

    const buf = await a.ser(payload);

    expect(await a.deser(buf)).toEqual(payload);
  });

  it('round-trips through lz4 when compression is enabled (and logs it)', async () => {
    const a = track(makeAdapter({ compression: { enabled: true, algo: 'lz4', options: {} } }));
    const payload = { type: 'x', blob: 'z'.repeat(2000) };

    const compressed = await a.ser(payload);
    const plain = Buffer.from(JSON.stringify(payload));

    expect(compressed.equals(plain)).toBe(false);          // actually compressed
    expect(await a.deser(compressed)).toEqual(payload);     // still round-trips
    expect(logger.has('info', /compression enabled/)).toBe(true);
  });
});

describe('publishMessage', () => {
  it('encodes the message and resolves once the broker confirms it', async () => {
    const a = track(makeAdapter());

    await a.publishMessage('writer' as never, { event: 'model_created', data: { id: 'r1' } } as never, { priority: 1 });

    expect(a.published).toEqual([
      { queue: 'writer', message: { event: 'model_created', data: { id: 'r1' } }, metadata: { priority: 1 } },
    ]);
  });

  it('turns a refusal into a NexxusMessageQueuePublishException naming the event and queue', async () => {
    const a = track(makeAdapter());

    a.publishImpl = () => Promise.reject(new Error('message nacked'));

    const err = await a.publishMessage('writer' as never, { event: 'model_created' } as never).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NexxusMessageQueuePublishException);
    expect((err as Error).message).toBe('Publishing "model_created" to "writer" failed: message nacked');
  });

  it('gives up when no confirmation arrives within publishTimeout', async () => {
    // A fraction of a second here; the schema allows 1–30.
    const a = track(makeAdapter({ publishTimeout: 0.05 }));

    a.publishImpl = () => new Promise<void>(() => {});

    await expect(a.publishMessage('writer' as never, { event: 'model_created' } as never))
      .rejects.toThrow('Publishing "model_created" to "writer" failed: not confirmed within 0.05 s');
  });
});

describe('construction', () => {
  it('throws when the logger service is not a NexxusBaseLogger', () => {
    const services = {
      configManager: { getConfig: () => ({}) },
      logger: { info() {}, warn() {} },
    } as unknown as INexxusBaseServices;

    expect(() => new FakeMqAdapter(services)).toThrow(/not an instance of NexxusBaseLogger/);
  });
});

describe('connect / disconnect', () => {
  it('resolves on first successful connection and emits connect', async () => {
    const a = track(makeAdapter());
    let connectedEvent = false;

    a.on('connect', () => { connectedEvent = true; });
    await a.connect();

    expect(a.connectedState).toBe(true);
    expect(a.doConnectCalls).toBe(1);
    expect(connectedEvent).toBe(true);
  });

  it('returns immediately when already connected (no second doConnect)', async () => {
    const a = track(makeAdapter());

    await a.connect();
    await a.connect();

    expect(a.doConnectCalls).toBe(1);
  });

  it('a second concurrent connect() attaches to the in-flight attempt without restarting the retry loop', async () => {
    const a = track(makeAdapter());
    let release!: () => void;

    a.gate = new Promise<void>(r => { release = r; });

    const p1 = a.connect();
    const p2 = a.connect(); // startRetryLoop sees the timer already set → early return

    await tick(10);
    release();
    await Promise.all([p1, p2]);

    expect(a.connectedState).toBe(true);
    expect(a.doConnectCalls).toBe(1); // one shared handshake
  });

  it('retries a retryable failure until it succeeds, warning each time', async () => {
    const a = track(makeAdapter());

    a.onDoConnect = () => {
      if (a.doConnectCalls < 3) {
        throw new Error('broker not ready');
      }
    };

    await a.connect();

    expect(a.doConnectCalls).toBe(3);
    expect(a.connectedState).toBe(true);
    expect(logger.has('warning', /connect failed, retrying/)).toBe(true);
  });

  it('rejects and emits error on a fatal connect failure', async () => {
    const a = track(makeAdapter());
    const errors: Error[] = [];

    a.on('error', e => errors.push(e));
    a.onDoConnect = () => { throw new Error('FATAL'); };

    await expect(a.connect()).rejects.toThrow(/MQ connect fatal/);
    expect(a.connectedState).toBe(false);
    expect(errors).toHaveLength(1);
    expect(logger.has('error', /fatal, not retrying/)).toBe(true);
  });

  it('gracefully disconnects, calling doDisconnect', async () => {
    const a = track(makeAdapter());

    await a.connect();
    await a.disconnect();

    expect(a.doDisconnectCalls).toBe(1);
    expect(a.connectedState).toBe(false);
  });

  it('rejects pending connect awaiters and tears down on a mid-handshake disconnect', async () => {
    const a = track(makeAdapter());
    let release!: () => void;

    a.gate = new Promise<void>(r => { release = r; });

    const pending = a.connect();

    await tick(10);           // doConnect is now awaiting the gate
    const disconnecting = a.disconnect(); // flips wantConnected false, rejects pending

    release();                // let doConnect resolve → tryOnce race branch runs
    await disconnecting;

    await expect(pending).rejects.toThrow(/disconnected before connection could be established/);
    expect(a.doDisconnectCalls).toBeGreaterThanOrEqual(1); // torn down by the race branch
  });
});

describe('reconnection', () => {
  it('emits disconnect and reconnects after an unexpected connection loss', async () => {
    const a = track(makeAdapter());
    let disconnectEvent = false;

    a.on('disconnect', () => { disconnectEvent = true; });
    await a.connect();

    a.lostConnection();

    expect(disconnectEvent).toBe(true);
    expect(a.connectedState).toBe(false);

    await tick(20); // retry loop reconnects

    expect(a.connectedState).toBe(true);
    expect(a.doConnectCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('consumers', () => {
  it('dispatches immediately to doConsume when connected', async () => {
    const a = track(makeAdapter());

    await a.connect();
    await a.consumeMessages('stage1' as never, async () => {});

    expect(a.consumeCalls).toEqual(['stage1']);
  });

  it('defers consumer registration until connected, then restores it', async () => {
    const a = track(makeAdapter());

    await a.consumeMessages('stage1' as never, async () => {}); // not connected yet

    expect(a.consumeCalls).toEqual([]);
    expect(a.consumerKeys).toEqual(['stage1']);

    await a.connect();

    expect(a.consumeCalls).toEqual(['stage1']); // restored on connect
  });

  it('auto-restores consumers after a reconnect', async () => {
    const a = track(makeAdapter());

    await a.connect();
    await a.consumeMessages('stage1' as never, async () => {});
    a.consumeCalls.length = 0;

    a.lostConnection();
    await tick(20);

    expect(a.consumeCalls).toEqual(['stage1']);
  });

  it('logs and continues when restoring a consumer throws on reconnect', async () => {
    const a = track(makeAdapter());

    await a.connect();
    await a.consumeMessages('stage1' as never, async () => {});

    a.failNextConsume = true;
    a.lostConnection();
    await tick(20);

    expect(a.connectedState).toBe(true); // reconnect still succeeded
    expect(logger.has('warning', /Failed to restore consumer/)).toBe(true);
  });
});

describe('pause / resume', () => {
  it('cancels on pause and re-registers on resume (both idempotent)', async () => {
    const a = track(makeAdapter());

    await a.connect();
    await a.consumeMessages('stage1' as never, async () => {});
    a.consumeCalls.length = 0;

    await a.pauseConsuming();
    await a.pauseConsuming(); // idempotent

    expect(a.paused).toBe(true);
    expect(a.cancelAllCalls).toBe(1);

    await a.resumeConsuming();
    await a.resumeConsuming(); // idempotent

    expect(a.paused).toBe(false);
    expect(a.consumeCalls).toEqual(['stage1']);
  });

  it('only sets the flag when pausing while disconnected', async () => {
    const a = track(makeAdapter());

    await a.pauseConsuming(); // never connected

    expect(a.paused).toBe(true);
    expect(a.cancelAllCalls).toBe(0);
  });

  it('does not restore consumers on reconnect while paused', async () => {
    const a = track(makeAdapter());

    await a.connect();
    await a.consumeMessages('stage1' as never, async () => {});
    await a.pauseConsuming();
    a.consumeCalls.length = 0;

    a.lostConnection();
    await tick(20);

    expect(a.connectedState).toBe(true);
    expect(a.consumeCalls).toEqual([]); // skipped because paused
  });
});

/** A connected adapter consuming `stage1` with `handler`; retries are 1 ms apart. */
const consuming = async (
  handler: (message: NexxusQueueMessage<any>) => Promise<void>,
  options?: NexxusConsumeOptions
): Promise<{ a: FakeMqAdapter; deliver: (delivery: NexxusMessageDelivery) => void }> => {
  const a = track(makeAdapter());

  a.useRetryDelays([ 1, 1, 1 ]);
  await a.connect();
  await a.consumeMessages('stage1' as never, handler, options);

  return { a, deliver: a.delivers.get('stage1')! };
};

describe('delivery handling', () => {
  it('acks once the handler resolves, having handed it the decoded payload and metadata', async () => {
    const received: NexxusQueueMessage<any>[] = [];
    const { deliver } = await consuming(async m => { received.push(m); });
    const d = fakeDelivery({ event: 'model_created', id: 'x' });

    deliver(d);

    await vi.waitFor(() => expect(d.settled).toEqual([ 'ack' ]));
    expect(received).toEqual([ { payload: { event: 'model_created', id: 'x' }, metadata: { tag: 1 } } ]);
  });

  it('dead-letters a payload that cannot be decoded, without running the handler', async () => {
    const handler = vi.fn(async () => {});
    const { deliver } = await consuming(handler);
    const d = fakeDelivery(undefined, Buffer.from('not json'));

    deliver(d);

    await vi.waitFor(() => expect(d.settled).toEqual([ 'deadLetter' ]));
    expect(handler).not.toHaveBeenCalled();
    expect(logger.has('error', /Giving up on a message from queue "stage1": it could not be decoded/)).toBe(true);
  });

  it('dead-letters a terminal failure at once', async () => {
    const handler = vi.fn(async () => { throw new UnknownApplicationException('App not found'); });
    const { deliver } = await consuming(handler);
    const d = fakeDelivery();

    deliver(d);

    await vi.waitFor(() => expect(d.settled).toEqual([ 'deadLetter' ]));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.has('error', /Giving up on message "model_created" from queue "stage1": App not found/)).toBe(true);
  });

  it('retries any other failure three times, then dead-letters it', async () => {
    // A plain Error isn't a NexxusException, so nothing says retrying is pointless.
    const handler = vi.fn(async () => { throw new Error('flaky'); });
    const { deliver } = await consuming(handler);
    const d = fakeDelivery();

    deliver(d);

    await vi.waitFor(() => expect(d.settled).toEqual([ 'deadLetter' ]));
    expect(handler).toHaveBeenCalledTimes(4); // the first attempt, plus three retries
    expect(logger.has('warning', /Retrying message "model_created" from queue "stage1" in 1 ms \(retry 3 of 3\): flaky/)).toBe(true);
    expect(logger.has('error', /Giving up on message "model_created" from queue "stage1" after 3 retries: flaky/)).toBe(true);
  });

  it('acks a message once a retry succeeds', async () => {
    let attempts = 0;
    const { deliver } = await consuming(async () => {
      attempts += 1;

      if (attempts < 3) {
        throw new Error('flaky');
      }
    });
    const d = fakeDelivery();

    deliver(d);

    await vi.waitFor(() => expect(d.settled).toEqual([ 'ack' ]));
    expect(attempts).toBe(3);
  });

  it('holds a message that failed while a service was down, and retries it once the service is back', async () => {
    let ready = false;
    let serviceBack: (() => void) | undefined;
    let attempts = 0;
    const { deliver } = await consuming(async () => {
      attempts += 1;

      if (!ready) {
        throw new Error('db down');
      }
    }, {
      isReady: () => ready,
      waitUntilReady: () => new Promise<void>(resolve => {
        serviceBack = () => { ready = true; resolve(); };
      })
    });
    const d = fakeDelivery();

    deliver(d);
    await vi.waitFor(() => expect(serviceBack).toBeDefined());
    await tick(10);

    // However long the outage lasts, the message is neither retried nor given up on.
    expect(d.settled).toEqual([]);
    expect(attempts).toBe(1);

    serviceBack!();

    await vi.waitFor(() => expect(d.settled).toEqual([ 'ack' ]));
    expect(attempts).toBe(2);
    expect(logger.has('warning', /once every service is back; it failed while one was down: db down/)).toBe(true);
    // The outage failure wasn't counted as a retry.
    expect(logger.has('warning', /\(retry \d of 3\)/)).toBe(false);
  });

  it('leaves a delivery alone once its connection is gone', async () => {
    let finish: (() => void) | undefined;
    const { deliver } = await consuming(() => new Promise<void>(resolve => { finish = resolve; }));
    const d = fakeDelivery();

    deliver(d);
    await vi.waitFor(() => expect(finish).toBeDefined());

    d.live = false;
    finish!();
    await tick(10);

    expect(d.settled).toEqual([]);
  });

  it('logs, rather than throws, when settling a delivery fails', async () => {
    const { deliver } = await consuming(async () => {});
    const d = fakeDelivery();

    d.ack = () => { throw new Error('channel closed'); };
    deliver(d);

    await vi.waitFor(() => expect(logger.has('warning', /Could not settle a message from queue "stage1": channel closed/)).toBe(true));
  });
});

describe('stopConsuming', () => {
  it('cancels every consumer, and keeps them from coming back', async () => {
    const { a } = await consuming(async () => {});

    a.consumeCalls.length = 0;

    await a.stopConsuming();
    await a.resumeConsuming();

    a.lostConnection();
    await tick(20);

    expect(a.cancelAllCalls).toBe(1);
    expect(a.consumeCalls).toEqual([]); // neither the resume nor the reconnect restored it
  });

  it('hands back a message waiting for a retry', async () => {
    const { a, deliver } = await consuming(async () => { throw new Error('flaky'); });
    const d = fakeDelivery();

    a.useRetryDelays([ 60_000 ]);
    deliver(d);
    await vi.waitFor(() => expect(logger.has('warning', /in 60000 ms/)).toBe(true));

    await a.stopConsuming();

    expect(d.settled).toEqual([ 'requeue' ]);
  });

  it('waits for a message being processed to finish', async () => {
    let finish: (() => void) | undefined;
    const { a, deliver } = await consuming(() => new Promise<void>(resolve => { finish = resolve; }));
    const d = fakeDelivery();
    let stopped = false;

    deliver(d);
    await vi.waitFor(() => expect(finish).toBeDefined());

    const stopping = a.stopConsuming(5_000).then(() => { stopped = true; });

    await tick(10);
    expect(stopped).toBe(false);

    finish!();
    await stopping;

    expect(d.settled).toEqual([ 'ack' ]);
  });

  it('stops waiting after the timeout, leaving the message to the broker', async () => {
    const { a, deliver } = await consuming(() => new Promise<void>(() => {})); // never finishes
    const d = fakeDelivery();

    deliver(d);
    await tick(10);
    await a.stopConsuming(20);

    expect(d.settled).toEqual([]);
  });

  it('hands back a message that arrives after it, without running the handler', async () => {
    const handler = vi.fn(async () => {});
    const { a, deliver } = await consuming(handler);
    const d = fakeDelivery();

    await a.stopConsuming();
    deliver(d);

    await vi.waitFor(() => expect(d.settled).toEqual([ 'requeue' ]));
    expect(handler).not.toHaveBeenCalled();
  });
});
