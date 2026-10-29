import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NexxusRabbitMq, NexxusRabbitMqBootstrapper } from '@mayhem93/nexxus-message-queue-lib';
import { NexxusBaseLogger, InvalidSchemaDataException, type INexxusBaseServices } from '@mayhem93/nexxus-core-lib';

// The amqplib mock itself is registered in index.test.ts (hoisted early); here
// we just import the shared fake to drive/inspect it.
import { state as amqpState, connect as amqpConnect, reset as resetAmqp } from './amqplibFake';

// Local alias so the rest of the suite reads naturally.
const h = { state: amqpState, connect: amqpConnect };

class TestLogger extends NexxusBaseLogger<Record<string, unknown>> {
  public entries: Array<{ level: string; message: string }> = [];
  public log(level: string, message: string): void { this.entries.push({ level, message }); }
  public async getStats(): Promise<Record<string, unknown>> { return {}; }
  public has(level: string, re: RegExp): boolean { return this.entries.some(e => e.level === level && re.test(e.message)); }
}

const logger = new TestLogger({});

/** A config as validation leaves it, schema defaults included. */
const config = (over: Record<string, unknown> = {}) => ({
  host: 'mq.local', port: 5672, user: 'u', password: 'p', managementPort: 15672, prefetch: 10, ...over,
});

const adapters: NexxusRabbitMq[] = [];

const makeAdapter = (cfg: Record<string, unknown> = config()): NexxusRabbitMq => {
  const services = { configManager: { getConfig: () => cfg }, logger } as unknown as INexxusBaseServices;
  const a = new NexxusRabbitMq(services);

  adapters.push(a);

  return a;
};

// Fast reconnect for the loop-driven paths.
const fast = (a: NexxusRabbitMq): NexxusRabbitMq => {
  (a as unknown as { reconnectDelayMs: number }).reconnectDelayMs = 5;

  return a;
};

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const mainChannel = () => h.state.channels[0];

beforeEach(() => {
  logger.entries = [];
  resetAmqp();
});

afterEach(async () => {
  for (const a of adapters) {
    await a.disconnect().catch(() => {});
  }
  adapters.length = 0;
});

describe('NexxusRabbitMq connect / getStats', () => {
  it('connects with the configured AMQP options and opens a channel', async () => {
    const a = makeAdapter();

    await a.connect();

    expect(h.connect).toHaveBeenCalledWith({
      protocol: 'amqp', hostname: 'mq.local', port: 5672, username: 'u', password: 'p', vhost: '/nexxus', heartbeat: 10,
    });
    expect(h.state.channels).toHaveLength(1);
  });

  it('reports stats when connected', async () => {
    const a = makeAdapter();

    await a.connect();

    expect(await a.getStats()).toEqual({
      id: 'mq.local', connected: true, channelOpen: true, brokerProduct: 'RabbitMQ', brokerVersion: '3.13.0',
    });
  });

  it('reports disconnected stats before connecting', async () => {
    expect(await makeAdapter().getStats()).toEqual({ id: 'unknown', connected: false });
  });

  it('getBootstrapper returns a RabbitMq bootstrapper', () => {
    const bs = makeAdapter().getBootstrapper({ runtimeUser: 'r', runtimePassword: 'pw' });

    expect(bs).toBeInstanceOf(NexxusRabbitMqBootstrapper);
  });

  it('classifies a login-refused error as fatal, others as retryable', () => {
    const a = makeAdapter();
    const isFatal = (a as unknown as { isFatalConnectError: (e: unknown) => boolean }).isFatalConnectError.bind(a);

    expect(isFatal(new Error('Login was refused using authentication'))).toBe(true);
    expect(isFatal(new Error('ECONNREFUSED'))).toBe(false);
  });
});

describe('NexxusRabbitMq publishMessage', () => {
  it('serializes as JSON and sends with persistent + json content-type', async () => {
    const a = makeAdapter();

    await a.connect();
    await a.publishMessage('writer' as never, { hello: 'world' } as never);

    const [queue, buf, opts] = mainChannel().sendToQueue.mock.calls[0];

    expect(queue).toBe('writer');
    expect(JSON.parse((buf as Buffer).toString())).toEqual({ hello: 'world' });
    expect(opts).toMatchObject({ persistent: true, contentType: 'application/json' });
  });

  it('merges caller metadata into the publish options', async () => {
    const a = makeAdapter();

    await a.connect();
    await a.publishMessage('writer' as never, { a: 1 } as never, { expiration: '5000' });

    expect(mainChannel().sendToQueue.mock.calls[0][2]).toMatchObject({ persistent: true, expiration: '5000' });
  });

  it('uses octet-stream content-type when compression is enabled', async () => {
    const a = makeAdapter(config({ compression: { enabled: true, algo: 'lz4', options: {} } }));

    await a.connect();
    await a.publishMessage('writer' as never, { a: 1 } as never);

    const [, buf, opts] = mainChannel().sendToQueue.mock.calls[0];

    expect(opts.contentType).toBe('application/octet-stream');
    expect((buf as Buffer).equals(Buffer.from(JSON.stringify({ a: 1 })))).toBe(false); // compressed
  });

  it('publishes on a confirm channel', async () => {
    const a = makeAdapter();

    await a.connect();

    expect(h.state.lastConnection.createConfirmChannel).toHaveBeenCalledOnce();
  });

  it('rejects when there is no channel to publish on', async () => {
    const a = makeAdapter();

    // Used to resolve without sending anything, so the API answered 202 for a
    // write that never reached the queue.
    await expect(a.publishMessage('writer' as never, { event: 'model_created' } as never))
      .rejects.toThrow('Publishing "model_created" to "writer" failed: no open channel');
  });

  it('rejects when the broker refuses the message', async () => {
    const a = makeAdapter();

    await a.connect();
    h.state.publishOutcome = 'nack';

    await expect(a.publishMessage('writer' as never, { event: 'model_created' } as never))
      .rejects.toThrow('Publishing "model_created" to "writer" failed: message nacked');
  });
});

describe('NexxusRabbitMq consume', () => {
  /** A message as amqplib hands it to a consumer. */
  const amqpMessage = (payload: unknown = { hello: 'world' }) => ({
    content: Buffer.from(JSON.stringify(payload)),
    fields: { deliveryTag: 1 },
    properties: { contentType: 'application/json' },
  });

  it('limits a consumer to the configured number of unacknowledged messages', async () => {
    const a = makeAdapter(config({ prefetch: 25 }));

    await a.connect();

    expect(mainChannel().prefetch).toHaveBeenCalledWith(25);
  });

  it('hands the handler the payload and metadata, then acks', async () => {
    const a = makeAdapter();
    const received: any[] = [];

    await a.connect();
    await a.consumeMessages('writer' as never, async m => { received.push(m); });

    const msg = amqpMessage();

    h.state.consumeCb!(msg);

    await vi.waitFor(() => expect(mainChannel().ack).toHaveBeenCalledWith(msg));
    expect(received[0].payload).toEqual({ hello: 'world' });
    expect(received[0].metadata).toEqual({ fields: msg.fields, properties: msg.properties });
  });

  it('dead-letters by rejecting without requeue', async () => {
    const a = makeAdapter();

    await a.connect();
    await a.consumeMessages('writer' as never, async () => { throw new InvalidSchemaDataException('bad'); });

    const msg = amqpMessage();

    h.state.consumeCb!(msg);

    // The queue's dead-letter policy takes it from there.
    await vi.waitFor(() => expect(mainChannel().nack).toHaveBeenCalledWith(msg, false, false));
    expect(mainChannel().ack).not.toHaveBeenCalled();
  });

  it('requeues a message still waiting for a retry when consumption stops', async () => {
    const a = makeAdapter();

    await a.connect();
    await a.consumeMessages('writer' as never, async () => { throw new Error('flaky'); });

    const msg = amqpMessage();

    h.state.consumeCb!(msg);

    await vi.waitFor(() => expect(logger.has('warning', /Retrying message from queue "writer" in/)).toBe(true));
    await a.stopConsuming();

    expect(mainChannel().nack).toHaveBeenCalledWith(msg, false, true);
  });

  it('leaves a message alone once the channel it arrived on is gone', async () => {
    const a = makeAdapter();
    let finish: (() => void) | undefined;

    await a.connect();
    await a.consumeMessages('writer' as never, () => new Promise<void>(resolve => { finish = resolve; }));

    const channel = mainChannel();

    h.state.consumeCb!(amqpMessage());
    await vi.waitFor(() => expect(finish).toBeDefined());

    h.state.handlers.close(); // the connection drops mid-processing
    finish!();
    await tick();

    // The broker took the message back with the channel; settling it on the
    // dead channel would fail, and on its replacement would close that one too.
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('ignores a null delivery (no callback, no ack)', async () => {
    const a = makeAdapter();
    const received: any[] = [];

    await a.connect();
    await a.consumeMessages('writer' as never, async m => { received.push(m); });
    h.state.consumeCb!(null);
    await tick();

    expect(received).toHaveLength(0);
    expect(mainChannel().ack).not.toHaveBeenCalled();
  });

  it('cancels tracked consumers on pause and swallows cancel errors', async () => {
    const a = makeAdapter();

    await a.connect();
    await a.consumeMessages('writer' as never, async () => {});

    mainChannel().cancel.mockRejectedValueOnce(new Error('cancel failed'));
    await a.pauseConsuming();

    expect(mainChannel().cancel).toHaveBeenCalledWith('ctag-1');
    expect(logger.has('warning', /Failed to cancel consumer tag/)).toBe(true);
  });
});

describe('NexxusRabbitMq queueExists', () => {
  it('throws when not connected', async () => {
    await expect(makeAdapter().queueExists('q')).rejects.toThrow(/connect\(\) before queueExists/);
  });

  it('returns true when checkQueue succeeds, on a throwaway channel that is closed', async () => {
    const a = makeAdapter();

    await a.connect();

    expect(await a.queueExists('q')).toBe(true);

    const temp = h.state.channels[1]; // the throwaway channel

    expect(temp.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(temp.close).toHaveBeenCalled();
  });

  it('returns false on a 404 (queue does not exist)', async () => {
    const a = makeAdapter();

    await a.connect();
    h.state.checkQueueImpl = async () => { const e: any = new Error('NOT_FOUND'); e.code = 404; throw e; };

    expect(await a.queueExists('q')).toBe(false);
  });

  it('returns true on any other error (e.g. 405 RESOURCE_LOCKED)', async () => {
    const a = makeAdapter();

    await a.connect();
    h.state.checkQueueImpl = async () => { const e: any = new Error('RESOURCE_LOCKED'); e.code = 405; throw e; };

    expect(await a.queueExists('q')).toBe(true);
  });
});

describe('NexxusRabbitMq volatile queue / delete', () => {
  it('creates a volatile queue with exclusive/autoDelete/non-durable options', async () => {
    const a = makeAdapter();

    await a.connect();
    await a.createVolatileQueue('slot_1');

    expect(mainChannel().assertQueue).toHaveBeenCalledWith('slot_1', { durable: false, autoDelete: true, exclusive: true });
  });

  it('deletes a queue by name', async () => {
    const a = makeAdapter();

    await a.connect();
    await a.deleteQueue('slot_1');

    expect(mainChannel().deleteQueue).toHaveBeenCalledWith('slot_1');
  });

  it('throws when creating/deleting while disconnected', async () => {
    const a = makeAdapter();

    await expect(a.createVolatileQueue('x')).rejects.toThrow(/connect\(\) before createVolatileQueue/);
    await expect(a.deleteQueue('x')).rejects.toThrow(/connect\(\) before deleteQueue/);
  });
});

describe('NexxusRabbitMq disconnect / connection events', () => {
  it('closes the underlying connection on disconnect', async () => {
    const a = makeAdapter();

    await a.connect();
    const conn = h.state.lastConnection;

    await a.disconnect();

    expect(conn.close).toHaveBeenCalled();
    expect(await a.getStats()).toEqual({ id: 'unknown', connected: false });
  });

  it('logs the error but leaves reconnection to the close handler on a connection error', async () => {
    const a = makeAdapter();

    await a.connect();
    h.state.handlers.error(new Error('socket blew up'));

    expect(logger.has('error', /RabbitMQ connection error/)).toBe(true);
  });

  it('reconnects when the connection close handler fires', async () => {
    const a = fast(makeAdapter());
    let disconnected = false;

    a.on('disconnect', () => { disconnected = true; });
    await a.connect();

    h.state.handlers.close(); // simulate unexpected close

    expect(disconnected).toBe(true);

    await tick(20); // retry loop reconnects via the fake

    expect(h.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
