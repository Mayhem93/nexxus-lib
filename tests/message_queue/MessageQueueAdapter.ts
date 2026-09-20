import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  NexxusMessageQueueAdapter,
  type NexxusMessageQueueConfig,
  type NexxusMessageQueueAdapterEvents,
  type NexxusMessageQueueAdapterStats,
  type NexxusQueueMessage,
} from '@mayhem93/nexxus-message-queue-lib';
import { NexxusBaseLogger, type INexxusBaseServices } from '@mayhem93/nexxus-core-lib';

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

  protected async doConsume(queueName: string, _cb: (m: NexxusQueueMessage<any>) => Promise<void>): Promise<void> {
    if (this.failNextConsume) {
      this.failNextConsume = false;

      throw new Error('doConsume boom');
    }

    this.consumeCalls.push(queueName);
  }

  protected async doCancelAll(): Promise<void> {
    this.cancelAllCalls += 1;
  }

  public async publishMessage(): Promise<void> { /* not exercised at the base level */ }
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
}

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
