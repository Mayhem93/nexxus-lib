import {
  NexxusBaseLogger,
  NexxusApplication,
  type INexxusApplication,
  type INexxusBaseServices
} from '@mayhem93/nexxus-core-lib';
import { NexxusDatabaseAdapter, type NexxusDatabaseAdapterEvents } from '@mayhem93/nexxus-database-lib';
import { NexxusMessageQueueAdapter, type NexxusQueueMessage } from '@mayhem93/nexxus-message-queue-lib';
import { NexxusRedis } from '@mayhem93/nexxus-redis';

import { NexxusApi } from '../../src/api/src/lib/Api';
import { NotFoundMiddleware, ErrorMiddleware } from '../../src/api/src/lib/middlewares';

import Express from 'express';
import * as net from 'node:net';
import type { Server } from 'node:http';

/* ------------------------------------------------------------------ *
 * Logger                                                              *
 * ------------------------------------------------------------------ */
export class TestLogger extends NexxusBaseLogger<Record<string, unknown>> {
  public entries: Array<{ level: string; message: string }> = [];
  public log(level: string, message: string): void { this.entries.push({ level, message }); }
  public async getStats(): Promise<Record<string, unknown>> { return { transports: [] }; }
  public has(level: string, re: RegExp): boolean { return this.entries.some(e => e.level === level && re.test(e.message)); }
}

export const logger = new TestLogger({});

/* ------------------------------------------------------------------ *
 * Fake database adapter (extends the real base so instanceof passes)  *
 * ------------------------------------------------------------------ */
export const dbState: {
  /** Returned by `getItems` unless `getItemsImpl` is set. */
  getItemsResult: any[];
  /** Returned by `searchItems` unless `searchImpl` is set. */
  searchResult: any[];
  countResult: number;
  updateResult: any[];
  /** Per-test overrides, for the cases a fixed array can't express (throwing, branching on options). */
  getItemsImpl: ((options: any) => any[] | Promise<any[]>) | null;
  searchImpl: ((options: any) => any[] | Promise<any[]>) | null;
  getItemsCalls: any[];
  searchCalls: any[];
  created: any[][];
  deleted: any[][];
  updateCalls: Array<{ patches: any[]; options: any }>;
} = {
  getItemsResult: [], searchResult: [], countResult: 0, updateResult: [],
  getItemsImpl: null, searchImpl: null,
  getItemsCalls: [], searchCalls: [], created: [], deleted: [], updateCalls: [],
};

/**
 * Unlike the worker's equivalent, this one's reads are programmable: the API's
 * routes exist to turn stored documents into responses, so a `getItems` that
 * always returns `[]` would make most of them untestable.
 */
export class FakeDb extends NexxusDatabaseAdapter<any, NexxusDatabaseAdapterEvents> {
  public async connect(): Promise<void> { this.emit('connect'); }
  public async disconnect(): Promise<void> {}
  public getBootstrapper(): never { return undefined as never; }

  public async getItems(options: any): Promise<any> {
    dbState.getItemsCalls.push(options);

    return dbState.getItemsImpl ? dbState.getItemsImpl(options) : dbState.getItemsResult;
  }

  public async searchItems(options: any): Promise<any> {
    dbState.searchCalls.push(options);

    return dbState.searchImpl ? dbState.searchImpl(options) : dbState.searchResult;
  }

  public async createItems(collection: any[]): Promise<void> { dbState.created.push(collection); }
  public async deleteItems(collection: any[]): Promise<void> { dbState.deleted.push(collection); }

  public async updateItems(patches: any[], options: any): Promise<any> {
    dbState.updateCalls.push({ patches, options });

    return dbState.updateResult;
  }

  public async countItems(): Promise<number> { return dbState.countResult; }
  protected buildQuery(): object { return {}; }
  public async getStats(): Promise<any> { return {}; }
}

/* ------------------------------------------------------------------ *
 * Fake MQ adapter (real base → real connection state machine)         *
 * ------------------------------------------------------------------ */
export const mqState: {
  published: Array<{ queue: string; message: any; metadata?: any }>;
  publishImpl: (() => void | Promise<void>) | null;
} = { published: [], publishImpl: null };

export class FakeMq extends NexxusMessageQueueAdapter<any, any, any> {
  protected reconnectDelayMs = 5;

  protected async doConnect(): Promise<void> {}
  protected async doDisconnect(): Promise<void> {}
  protected isFatalConnectError(): boolean { return false; }
  protected async doConsume(_queue: string, _cb: (m: NexxusQueueMessage<any>) => Promise<void>): Promise<void> {}
  protected async doCancelAll(): Promise<void> {}
  public getBootstrapper(): never { return undefined as never; }

  public async publishMessage(queueName: any, message: any, metadata?: any): Promise<void> {
    if (mqState.publishImpl) await mqState.publishImpl();

    mqState.published.push({ queue: queueName, message, metadata });
  }

  public async queueExists(): Promise<boolean> { return false; }
  public async createVolatileQueue(): Promise<void> {}
  public async deleteQueue(): Promise<void> {}
  public async getStats(): Promise<any> { return { id: 'fake-mq' }; }
}

/* ------------------------------------------------------------------ *
 * NexxusApi statics                                                   *
 * ------------------------------------------------------------------ */

/**
 * `loadedApps` is `private static` and `getStoredApp` is the only way in, so
 * seeding goes through the map directly. TypeScript's `private` is erased at
 * runtime, and the alternative — booting a real `NexxusApi` so `loadApps()`
 * runs — would drag in three service connections, helmet and a listening
 * socket just to put an object in a Map. `tests/redis/helpers.ts` reaches into
 * `NexxusRedis.instance` the same way.
 */
const loadedApps = (NexxusApi as unknown as { loadedApps: Map<string, NexxusApplication> }).loadedApps;

/** Strategy instances the fake `NexxusApi.instance` hands back, keyed `${appId}|${name}`. */
export const authStrategies: Map<string, unknown> = new Map();

export type ApiHarness = {
  db: FakeDb;
  mq: FakeMq;
  redis: NexxusRedis;
};

/**
 * Point the API's process-wide statics at fakes and clear everything a previous
 * suite left behind.
 *
 * Call from a DESCRIBE-SCOPED `beforeEach`. A module-level one registers on the
 * test FILE's root suite, so it would run before every test in every imported
 * suite, in import order — the last one registered wins and silently resets
 * state another suite just set up.
 */
export function installApiStatics(): ApiHarness {
  logger.entries = [];
  loadedApps.clear();
  authStrategies.clear();

  Object.assign(dbState, {
    getItemsResult: [], searchResult: [], countResult: 0, updateResult: [],
    getItemsImpl: null, searchImpl: null,
    getItemsCalls: [], searchCalls: [], created: [], deleted: [], updateCalls: [],
  });
  Object.assign(mqState, { published: [], publishImpl: null });

  const configManager = { getConfig: () => ({}) };
  const baseServices = { configManager, logger } as unknown as INexxusBaseServices;

  const db = new FakeDb(baseServices);
  const mq = new FakeMq(baseServices);
  const redis = new NexxusRedis(baseServices);

  redis.init = async () => { redis.emit('connect'); };
  redis.close = async () => {};

  NexxusApi.logger = logger;
  NexxusApi.database = db;
  NexxusApi.messageQueue = mq;
  NexxusApi.redis = redis;

  // Routes reach the running service through this (`User.register` asks it for
  // the app's local strategy). A stand-in rather than a real NexxusApi, because
  // constructing one would require the full config + service validation.
  NexxusApi.instance = {
    getAppAuthStrategy: (appId: string, name: string) => authStrategies.get(`${appId}|${name}`),
  } as unknown as NexxusApi;

  return { db, mq, redis };
}

/** Make `getStoredApp(app.id)` resolve. Returns the app so callers can chain. */
export function seedApp(app: NexxusApplication): NexxusApplication {
  loadedApps.set(app.getData().id as string, app);

  return app;
}

/** Register a strategy instance for the fake `NexxusApi.instance` to hand back. */
export function seedAuthStrategy(appId: string, name: string, strategy: unknown): void {
  authStrategies.set(`${appId}|${name}`, strategy);
}

/**
 * A valid application, with per-test overrides. No `auth` block by default —
 * that's the zero-auth flavour, and the flavour a test cares about should be
 * visible at the call site rather than inherited.
 */
export function makeApp(overrides: Record<string, unknown> = {}): NexxusApplication {
  return new NexxusApplication({
    id: 'app1',
    type: 'application',
    name: 'Test App',
    signingSecret: 'signing-secret',
    schema: { runs: { fields: { note: { type: 'string', required: false } } } },
    ...overrides,
  } as INexxusApplication);
}

/** The same application with authentication enabled. */
export function makeAuthApp(overrides: Record<string, unknown> = {}): NexxusApplication {
  const { auth, ...rest } = overrides as { auth?: Record<string, unknown> };

  return makeApp({
    auth: {
      strategies: { local: {} },
      userDetailSchema: { default: {} },
      ...auth,
    },
    ...rest,
  });
}

/* ------------------------------------------------------------------ *
 * Test server                                                         *
 * ------------------------------------------------------------------ */
export type TestResponse = {
  status: number;
  /** Parsed JSON when the response was JSON, otherwise the raw text. */
  body: any;
  headers: Headers;
};

export type TestServer = {
  url: string;
  request: (path: string, init?: RequestInit) => Promise<TestResponse>;
  close: () => Promise<void>;
};

/**
 * Ask the OS for a free port, by probing and releasing it.
 *
 * AVOID where you can: bind port 0 on the real server and read the port back
 * from `server.address()` instead. That is atomic, whereas this leaves a gap
 * between "the OS said this port was free" and "we bound it" — and on a Windows
 * host with Hyper-V enabled, HNS reserves TCP ranges that can make the second
 * bind fail even though the probe succeeded.
 *
 * Only for the few callers that need a port BEFORE the thing that will listen
 * on it exists — a config object read during construction, say.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;

      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start a real Express app on a real port and return a `fetch` wrapper for it.
 *
 * Real rather than hand-rolled `req`/`res` objects because a good deal of this
 * package's behaviour IS the wiring: five middlewares signal failure by
 * THROWING rather than calling `next(err)`, which only works because Express 5
 * catches throws and routes them to the error handler. Calling a handler
 * directly would test the one part that isn't in question and skip the part
 * that is.
 *
 * `mount` receives the app, which is what `NexxusApiBaseRoute` subclasses take
 * as their parent router. The JSON body parser goes on first and the
 * NotFound → Error pair last, mirroring `NexxusApi.init()` — without the error
 * middleware a thrown exception surfaces as Express's default HTML page and
 * every status assertion becomes a 500.
 *
 * Start ONE per suite, not per test: `fileParallelism` is off, so a listen per
 * test is pure serial cost.
 */
export async function startTestServer(mount: (app: Express.Express) => void): Promise<TestServer> {
  const app = Express();

  // Close every connection after its response.
  //
  // A suite starts and stops dozens of servers on OS-assigned ports, and the
  // OS recycles ports within a run — so a socket `fetch` kept pooled against a
  // closed server could be handed back for a request to a NEW server on the
  // same port, surfacing as an intermittent "fetch failed" in whichever
  // unrelated test drew the short straw. This header makes the client evict the
  // connection as soon as the response arrives, which is deterministic;
  // `keepAliveTimeout` is not (and 0 means "never time out", not "no
  // keep-alive").
  app.use(((_req, res, next) => { res.setHeader('Connection', 'close'); next(); }) as Express.RequestHandler);
  app.use(Express.json());
  mount(app);
  app.use(NotFoundMiddleware);
  app.use(ErrorMiddleware);

  // Port 0: the OS assigns one AT bind time, so there is no window in which
  // another server could take it.
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0);

    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // Fail HERE, naming what the server reported, rather than letting a port of 0
  // travel into a URL and surface as `fetch failed` in whichever test used it.
  if (!port) {
    throw new Error(`test server reported no port after listening: ${JSON.stringify(address)}`);
  }

  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    async request(path: string, init: RequestInit = {}): Promise<TestResponse> {
      const res = await fetch(`${url}${path}`, init);
      const text = await res.text();
      let body: any = text;

      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON — hand back the raw text so a failing assertion shows what
        // actually came back instead of a parse error.
      }

      return { status: res.status, body, headers: res.headers };
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        // Tear sockets down rather than waiting for them to drain: an
        // undestroyed one keeps this port claimed AND keeps a stale entry in
        // the client's connection pool.
        server.closeAllConnections();
        server.close((err?: Error) => err ? reject(err) : resolve());
      });
    },
  };
}

/** `fetch` init for a JSON request body. */
export function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}
