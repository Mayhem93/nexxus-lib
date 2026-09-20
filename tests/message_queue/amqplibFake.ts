import { vi } from 'vitest';

/**
 * Shared in-memory fake for `amqplib`. Registered as the mock in index.test.ts
 * (hoisted before any suite import, so it wins over the real module even though
 * the mq barrel pulls amqplib in transitively during the first suite). The
 * RabbitMq suite imports `state`/`connect`/`reset` from here to steer behavior
 * and inspect what the adapter wired up.
 */
export const state: {
  channels: any[];
  handlers: Record<string, (...a: any[]) => void>;
  lastConnection: any;
  serverProperties: { product?: string; version?: string };
  connectImpl: ((opts: any) => Promise<any>) | null;
  checkQueueImpl: ((name: string) => Promise<unknown>) | null;
  consumeCb: ((msg: any) => Promise<void>) | null;
  consumeQueue: string | null;
  nextConsumerTag: string;
} = {
  channels: [],
  handlers: {},
  lastConnection: null,
  serverProperties: { product: 'RabbitMQ', version: '3.13.0' },
  connectImpl: null,
  checkQueueImpl: null,
  consumeCb: null,
  consumeQueue: null,
  nextConsumerTag: 'ctag-1',
};

const makeChannel = () => ({
  sendToQueue: vi.fn(),
  consume: vi.fn(async (queue: string, cb: (msg: any) => Promise<void>) => {
    state.consumeCb = cb;
    state.consumeQueue = queue;

    return { consumerTag: state.nextConsumerTag };
  }),
  ack: vi.fn(),
  checkQueue: vi.fn(async (name: string) => (state.checkQueueImpl ? state.checkQueueImpl(name) : {})),
  assertQueue: vi.fn(async () => ({})),
  deleteQueue: vi.fn(async () => ({ messageCount: 0 })),
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  on: vi.fn(),
});

export const connect = vi.fn(async (opts: any) => {
  if (state.connectImpl) {
    return state.connectImpl(opts);
  }

  const conn: any = {
    createChannel: vi.fn(async () => {
      const ch = makeChannel();

      state.channels.push(ch);

      return ch;
    }),
    on: vi.fn((ev: string, cb: (...a: any[]) => void) => { state.handlers[ev] = cb; }),
    once: vi.fn((ev: string, cb: (...a: any[]) => void) => { state.handlers[ev] = cb; }),
    close: vi.fn(async () => {}),
    connection: { serverProperties: state.serverProperties },
  };

  state.lastConnection = conn;

  return conn;
});

/** Reset call history + steerable behavior between tests. */
export function reset(): void {
  connect.mockClear();
  Object.assign(state, {
    channels: [],
    handlers: {},
    lastConnection: null,
    connectImpl: null,
    checkQueueImpl: null,
    consumeCb: null,
    consumeQueue: null,
    nextConsumerTag: 'ctag-1',
  });
}
