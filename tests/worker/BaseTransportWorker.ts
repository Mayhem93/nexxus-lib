import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusBaseTransportWorker, NexxusBaseWorker, NexxusWorkerUnsupportedEventException } from '@mayhem93/nexxus-worker-lib';
import { makeHarness, logger, mqState, resetWorkerStatics, type WorkerHarness } from './harness';

class FakeTransport extends NexxusBaseTransportWorker<any> {
  protected queueName: any = 'websockets-transport';
  protected nodeRole = 'websockets-transport';
  public order: string[] = [];
  public sent: Array<{ deviceId: string; connectionId: string; data: any }> = [];
  /** What the worker could rely on at the moment `beforeConsume` ran. */
  public atBeforeConsume: { available: boolean; consuming: boolean } | null = null;

  protected async beforeConsume(): Promise<void> {
    this.order.push('beforeConsume');
    this.atBeforeConsume = { available: this.isAvailable, consuming: mqState.consumed.length > 0 };
  }
  protected async initTransport(): Promise<void> { this.order.push('initTransport'); }
  protected async sendToConnection(deviceId: string, connectionId: string, data: any): Promise<void> {
    this.sent.push({ deviceId, connectionId, data });
  }

  public any(): any { return this; }
}

const workers: FakeTransport[] = [];
let h: WorkerHarness;

beforeEach(async () => {
  resetWorkerStatics(NexxusBaseWorker);
  h = await makeHarness();
});

afterEach(async () => {
  for (const w of workers) await w.close().catch(() => {});
  workers.length = 0;
});

const worker = (): FakeTransport => {
  const w = new FakeTransport(h.services);

  workers.push(w);

  return w;
};

const deviceMessage = (recipients: Array<{ deviceId: string; connectionId: string }>) => ({
  payload: { event: 'device_message', recipients, data: { event: 'update', some: 'thing' } },
});

describe('NexxusBaseTransportWorker.init', () => {
  it('runs beforeConsume once every service is connected and before consuming, then initTransport', async () => {
    const w = worker();

    await w.init();

    // A volatile transport picks its slot in beforeConsume: it asks the broker
    // which slot queues exist, then renames the queue about to be consumed.
    expect(w.atBeforeConsume).toEqual({ available: true, consuming: false });
    expect(w.order).toEqual(['beforeConsume', 'initTransport']);
    expect(w.any().initialized).toBe(true);
  });

  it('warns and short-circuits when already initialized', async () => {
    const w = worker();

    await w.init();
    w.order.length = 0;
    logger.entries = [];

    await w.init();

    expect(w.order).toEqual([]); // no second beforeConsume/initTransport
    expect(logger.has('warning', /FakeTransport already initialized/)).toBe(true);
  });
});

describe('NexxusBaseTransportWorker.processMessage', () => {
  it('fans a device_message out to every recipient connection', async () => {
    const w = worker();

    await w.any().processMessage(deviceMessage([
      { deviceId: 'd1', connectionId: 'c1' },
      { deviceId: 'd1', connectionId: 'c2' },
      { deviceId: 'd2', connectionId: 'c3' },
    ]));

    expect(w.sent.map(s => [ s.deviceId, s.connectionId ])).toEqual([ [ 'd1', 'c1' ], [ 'd1', 'c2' ], [ 'd2', 'c3' ] ]);
    expect(w.sent[0].data).toEqual({ event: 'update', some: 'thing' });
  });

  it('warns on device_logout — only a volatile transport has connections to drop', async () => {
    const w = worker();

    await w.any().processMessage({ payload: { event: 'device_logout', deviceIds: [ 'd1' ] } });

    expect(w.sent).toHaveLength(0);
    expect(logger.has('warning', /device_logout for 1 device\(s\), but this transport holds no connections/)).toBe(true);
  });

  it('warns on connection_evicted — only a volatile transport has connections to close', async () => {
    const w = worker();

    await w.any().processMessage({ payload: { event: 'connection_evicted', connections: [ { deviceId: 'd1', connectionId: 'c1' } ] } });

    expect(w.sent).toHaveLength(0);
    expect(logger.has('warning', /connection_evicted for 1 connection\(s\), but this transport holds no connections/)).toBe(true);
  });

  it('fails an unknown event type with a terminal error, so it is dead-lettered', async () => {
    const w = worker();
    const err = await w.any().processMessage({ payload: { event: 'something_else' } })
      .catch((e: unknown) => e) as NexxusWorkerUnsupportedEventException;

    expect(err).toBeInstanceOf(NexxusWorkerUnsupportedEventException);
    expect(err.terminal).toBe(true);
    expect(err.message).toBe('Transports don\'t handle "something_else" events');
    expect(w.sent).toHaveLength(0);
  });

  it('warns and drops a device_message with no recipients', async () => {
    const w = worker();

    await w.any().processMessage(deviceMessage([]));

    expect(w.sent).toHaveLength(0);
    expect(logger.has('warning', /No recipients provided/)).toBe(true);
  });
});
