import { vi } from 'vitest';

/**
 * Fake for the `redis` module (used only by the NexxusRedis SERVICE test).
 * Registered as the mock in index.test.ts. The model tests don't touch this —
 * they inject a stateful FakeRedis via NexxusRedis.instance instead.
 */
export const rstate: {
  infoText: string;
  dbSize: number;
  handlers: Record<string, (...a: any[]) => void>;
  lastOptions: any;
  created: 'client' | 'cluster' | null;
  closed: boolean;
  infoImpl: (() => Promise<string>) | null;
} = {
  infoText: '',
  dbSize: 0,
  handlers: {},
  lastOptions: null,
  created: null,
  closed: false,
  infoImpl: null,
};

export const fakeClient: any = {
  connect: vi.fn(async () => {}),
  on: vi.fn((ev: string, cb: (...a: any[]) => void) => { rstate.handlers[ev] = cb; return fakeClient; }),
  info: vi.fn(async () => (rstate.infoImpl ? rstate.infoImpl() : rstate.infoText)),
  dbSize: vi.fn(async () => rstate.dbSize),
  close: vi.fn(async () => { rstate.closed = true; }),
};

export const createClient = vi.fn((opts: any) => { rstate.lastOptions = opts; rstate.created = 'client'; return fakeClient; });
export const createCluster = vi.fn((opts: any) => { rstate.lastOptions = opts; rstate.created = 'cluster'; return fakeClient; });

export function resetRedisModule(): void {
  [createClient, createCluster, fakeClient.connect, fakeClient.on, fakeClient.info, fakeClient.dbSize, fakeClient.close]
    .forEach(fn => fn.mockClear());
  Object.assign(rstate, { infoText: '', dbSize: 0, handlers: {}, lastOptions: null, created: null, closed: false, infoImpl: null });
}
