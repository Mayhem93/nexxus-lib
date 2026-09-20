import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusBaseTransportWorker, NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { makeHarness, logger, resetWorkerStatics, type WorkerHarness } from './harness';

class FakeTransport extends NexxusBaseTransportWorker<any> {
  protected queueName: any = 'websockets-transport';
  protected nodeRole = 'websockets-transport';
  public order: string[] = [];
  public sent: Array<{ deviceId: string; data: any }> = [];

  protected async beforeConsume(): Promise<void> { this.order.push('beforeConsume'); }
  protected async initTransport(): Promise<void> { this.order.push('initTransport'); }
  protected async sendToDevice(deviceId: string, data: any): Promise<void> { this.sent.push({ deviceId, data }); }

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

const deviceMessage = (deviceIds: string[]) => ({
  payload: { event: 'device_message', deviceIds, data: { event: 'update', some: 'thing' } },
});

describe('NexxusBaseTransportWorker.init', () => {
  it('runs beforeConsume, then the base init, then initTransport', async () => {
    const w = worker();

    await w.init();

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
  it('fans a device_message out to every device id', async () => {
    const w = worker();

    await w.any().processMessage(deviceMessage(['d1', 'd2']));

    expect(w.sent.map(s => s.deviceId)).toEqual(['d1', 'd2']);
    expect(w.sent[0].data).toEqual({ event: 'update', some: 'thing' });
  });

  it('warns and drops an unknown event type', async () => {
    const w = worker();

    await w.any().processMessage({ payload: { event: 'something_else' } });

    expect(w.sent).toHaveLength(0);
    expect(logger.has('warning', /Unknown event type: something_else/)).toBe(true);
  });

  it('warns and drops a device_message with no device ids', async () => {
    const w = worker();

    await w.any().processMessage(deviceMessage([]));

    expect(w.sent).toHaveLength(0);
    expect(logger.has('warning', /No device IDs provided/)).toBe(true);
  });
});
