import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  NexxusApplication, NexxusAclRole, DEFAULT_ACL_ROLE_ID, FatalErrorException,
  InvalidConfigException, authDetailKey,
  type INexxusAclRole, type INexxusApplication,
} from '@mayhem93/nexxus-core-lib';

import { NexxusApi } from '../../src/api/src/lib/Api';
import NexxusLocalAuthStrategy from '../../src/api/src/lib/auth/LocalAuthStrategy';
import NexxusGoogleAuthStrategy from '../../src/api/src/lib/auth/GoogleAuthStrategy';

import {
  installApiStatics, makeAuthApp, dbState, logger, startTestServer, type TestServer,
  FakeDb, FakeMq,
} from './harness';
import { installFakeRedis } from '../redis/helpers';

import { NexxusRedis } from '@mayhem93/nexxus-redis';

const GOOGLE_CONFIG = {
  clientID: 'client-id',
  clientSecret: 'client-secret',
  callbackURL: 'http://localhost/auth/google/callback',
};

type Harness = {
  api: NexxusApi;
  /** Resolved AFTER `init()` — the config asks for port 0, the OS picks one. */
  readonly port: number;
  readonly managementPort: number;
  db: FakeDb;
  mq: FakeMq;
  redis: NexxusRedis;
  /** `fetch` against the API's own listening port. */
  request: (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;
};

let harness: Harness | null = null;

/**
 * Construct a REAL `NexxusApi` over the fake service adapters.
 *
 * This is the one suite that builds the service itself rather than mounting
 * routes on a bare Express app: `init()`/`close()` lifecycle, the availability
 * state machine and the boot-time validation ARE the subject here, and none of
 * them exist outside a real instance.
 */
async function makeApi(configOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const { db, mq, redis } = installApiStatics();

  installFakeRedis();

  // Port 0 for both servers: the OS assigns one AT bind time, which is atomic.
  // Asking for a specific port first leaves a window in which something else
  // can take it — and on a Windows host with Hyper-V, HNS reserves TCP ranges
  // that can refuse a bind the probe had just succeeded on.
  const config = {
    name: 'test-api',
    port: 0,
    logger: 'WinstonNexxusLogger',
    database: 'NexxusElasticsearchDb',
    message_queue: 'NexxusRabbitMq',
    management: { port: 0, token: 'tok' },
    ...configOverrides,
  };

  const configManager = { getConfig: (key: string) => (key === 'app' ? config : {}) };
  const api = new NexxusApi({
    configManager, logger, database: db, messageQueue: mq, redis,
  } as unknown as never);

  /** Read a live server's assigned port. Both are private — nothing else exposes them. */
  const portOf = (holder: unknown): number => {
    const server = holder as { address?: () => { port: number } | null } | null | undefined;

    return server?.address?.()?.port ?? 0;
  };
  const internals = api as unknown as {
    server?: unknown;
    managementServer?: { server?: unknown } | null;
  };

  harness = {
    api, db, mq, redis,
    get port() { return portOf(internals.server); },
    get managementPort() { return portOf(internals.managementServer?.server); },
    // Reads the port through the closure, not `this` — every test destructures
    // `request` off the harness, which would leave `this` undefined.
    async request(path: string, init: RequestInit = {}) {
      const res = await fetch(`http://127.0.0.1:${portOf(internals.server)}${path}`, {
        ...init,
        headers: { connection: 'close', ...(init.headers as Record<string, string>) },
      });
      const text = await res.text();

      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    },
  };

  return harness;
}

/** An application document as `loadApps` would read it from the database. */
const appDoc = (overrides: Record<string, unknown> = {}): NexxusApplication => new NexxusApplication({
  id: 'app1', type: 'application', name: 'Test App', signingSecret: 's',
  schema: { runs: { fields: { note: { type: 'string', required: false } } } },
  ...overrides,
} as INexxusApplication);

const aclRole = (id: string, statements: unknown): NexxusAclRole => new NexxusAclRole({
  id, type: 'acl', appId: 'app1', statements: JSON.stringify(statements),
} as INexxusAclRole);

/**
 * Bring every upstream up. Emitted per service rather than in a loop: the three
 * adapters have different typed event maps, so a loop over them widens to a
 * union `emit` TypeScript can't call.
 */
function connectAll(h: Harness): void {
  h.db.emit('connect');
  h.mq.emit('connect');
  h.redis.emit('connect');
}

afterEach(async () => {
  // Always tear down: each instance holds two listening ports.
  if (harness) {
    try { await harness.api.close(); } catch { /* already closed */ }

    harness = null;
  }
});

describe('NexxusApi — construction', () => {
  let services: Record<string, unknown>;

  beforeEach(() => {
    const built = installApiStatics();

    services = {
      configManager: { getConfig: () => ({ port: 0, management: { port: 0, token: 't' } }) },
      logger,
      database: built.db,
      messageQueue: built.mq,
      redis: built.redis,
    };
  });

  it.each([
    [ 'logger', 'Logger service is not an instance of NexxusBaseLogger' ],
    [ 'database', 'Database service is not an instance of NexxusDatabaseAdapter' ],
    [ 'messageQueue', 'Message Queue service is not an instance of NexxusMessageQueueAdapter' ],
    [ 'redis', 'Redis service is not an instance of NexxusRedis' ],
  ])('refuses a %s that is not the real base class', (key, message) => {
    // The instanceof guards are what catch a plugin resolved from a duplicate
    // copy of core — the failure mode is otherwise a method-missing error deep
    // into a request.
    expect(() => new NexxusApi({ ...services, [key]: { not: 'a service' } } as unknown as never))
      .toThrow(new FatalErrorException(message));
  });

  it('publishes the services as statics and itself as the instance', () => {
    const api = new NexxusApi(services as unknown as never);

    expect(NexxusApi.database).toBe(services.database);
    expect(NexxusApi.messageQueue).toBe(services.messageQueue);
    expect(NexxusApi.redis).toBe(services.redis);
    expect(NexxusApi.logger).toBe(services.logger);
    // Routes reach the running service through this to find per-app strategies.
    expect(NexxusApi.instance).toBe(api);
  });

  it('hides the framework banner', () => {
    const api = new NexxusApi(services as unknown as never);

    expect((api as unknown as { express: { get(k: string): unknown } }).express.get('x-powered-by'))
      .toBeFalsy();
  });

  it('fails at construction when an SSL file is missing, not at listen', async () => {
    const built = installApiStatics();

    expect(() => new NexxusApi({
      configManager: {
        getConfig: () => ({
          port: 0, management: { port: 0, token: 't' },
          ssl: { sslKeyPath: '/no/such/key.pem', sslCertPath: '/no/such/cert.pem' },
        }),
      },
      logger, database: built.db, messageQueue: built.mq, redis: built.redis,
    } as unknown as never)).toThrow(/ENOENT/);
  });
});

describe('NexxusApi — availability', () => {
  it('is unavailable until every upstream has connected', async () => {
    const { api, db, mq, redis } = await makeApi();

    expect(api.isAvailable).toBe(false);

    db.emit('connect');
    expect(api.isAvailable).toBe(false);

    mq.emit('connect');
    expect(api.isAvailable).toBe(false);

    redis.emit('connect');
    expect(api.isAvailable).toBe(true);
  });

  it('becomes unavailable again when any one drops', async () => {
    const { api, mq } = await makeApi();

    connectAll(harness!);
    expect(api.isAvailable).toBe(true);

    mq.emit('disconnect');
    expect(api.isAvailable).toBe(false);

    mq.emit('connect');
    expect(api.isAvailable).toBe(true);
  });

  it('logs a transition once, not per event', async () => {
    const { db } = await makeApi();

    db.emit('connect');
    db.emit('connect');

    const connects = logger.entries.filter(e => /Upstream service "db" connected/.test(e.message));

    expect(connects).toHaveLength(1);
  });

  it('ignores a repeated disconnect', async () => {
    const { api, db } = await makeApi();

    connectAll(harness!);
    db.emit('disconnect');
    logger.entries = [];
    db.emit('disconnect');

    // Adapters can emit on every failed reconnect attempt; one outage should
    // not become a stream of identical warnings.
    expect(logger.has('warning', /disconnected/)).toBe(false);
    expect(api.isAvailable).toBe(false);
  });

  it('does not wait when the upstreams are already connected', async () => {
    const { api } = await makeApi();

    // The adapters here connect synchronously on `connect()`, so `init()` finds
    // itself already available and must take the resolve-immediately path
    // rather than parking on a promise nothing will settle.
    connectAll(harness!);

    await expect(api.init()).resolves.toBeUndefined();
  });

  it('warns when an upstream drops while serving', async () => {
    const { db } = await makeApi();

    connectAll(harness!);
    db.emit('disconnect');

    expect(logger.has('warning', /Upstream service "db" disconnected/)).toBe(true);
  });

  it('stays quiet about disconnects caused by our own shutdown', async () => {
    const { api, db } = await makeApi();

    connectAll(harness!);
    await api.close();

    logger.entries = [];
    db.emit('disconnect');

    // Shutting down produces disconnects by design; warning about them would
    // make every clean stop look like an incident.
    expect(logger.has('warning', /disconnected/)).toBe(false);
  });
});

describe('NexxusApi.init', () => {
  it('waits for every upstream, then listens and serves', async () => {
    const { api, request } = await makeApi();

    await api.init();

    const res = await request('/');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Welcome to the Nexxus API!' });
  });

  it('loads the applications from the database', async () => {
    const { api } = await makeApi();

    dbState.searchImpl = (o) => (o.type === 'application' ? [ appDoc(), appDoc({ id: 'app2' }) ] : []);

    await api.init();

    expect(NexxusApi.getStoredApp('app1')).toBeDefined();
    expect(NexxusApi.getStoredApp('app2')).toBeDefined();
    expect(logger.has('info', /Loaded 2 applications/)).toBe(true);
  });

  it('mounts every route', async () => {
    const { api, request } = await makeApi();

    dbState.searchImpl = (o) => (o.type === 'application' ? [ appDoc() ] : []);

    await api.init();

    // Each answers with its OWN rejection, which proves it is mounted and
    // reachable rather than falling through to NotFound. All 400 here because
    // this application has no authentication: the routes are reached, and each
    // one objects to what the request is missing.
    for (const [ path, init ] of [
      [ '/device', {} ],
      [ '/user/me', {} ],
      [ '/model/m1', {} ],
      [ '/subscription', { method: 'DELETE' } ],
    ] as Array<[ string, RequestInit ]>) {
      const res = await request(path, { ...init, headers: { 'nxx-app-id': 'app1' } });

      expect(res.status, `${path} should be reachable`).toBe(400);
      expect(res.body.error).not.toBe('NotFoundException');
    }
  });

  /**
   * `listen()` returns immediately, so without awaiting the socket `init()`
   * resolved while connections were still being refused — and the very next
   * thing it does is register with Hub, advertising a port this node cannot
   * yet serve. It also made the test suite intermittently fail with an
   * inscrutable "fetch failed".
   */
  it('is accepting connections by the time init() resolves', async () => {
    const h = await makeApi();

    await h.api.init();

    // No wait, no retry, no poll — the first request after init() must work.
    expect((await h.request('/')).status).toBe(200);
  });

  it('rejects rather than emitting an unhandled error when the port is taken', async () => {
    const occupied = await makeApi();

    await occupied.api.init();

    const clash = await makeApi({ port: occupied.port });

    await expect(clash.api.init()).rejects.toThrow(/EADDRINUSE|EACCES/);
    await occupied.api.close();
  });

  it('404s an unknown path through the error middleware', async () => {
    const { api, request } = await makeApi();

    await api.init();

    const res = await request('/nope');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'NotFoundException' });
  });

  it('503s every request while an upstream is down', async () => {
    const { api, request, db } = await makeApi();

    await api.init();
    db.emit('disconnect');

    const res = await request('/');

    // The gate reads live state, so a mid-life outage is reflected without
    // re-wiring anything — and it answers in the standard error shape.
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ServiceUnavailableException');
  });

  it('serves again once the upstream returns', async () => {
    const { api, request, db } = await makeApi();

    await api.init();
    db.emit('disconnect');
    db.emit('connect');

    expect((await request('/')).status).toBe(200);
  });

  it('starts the management server', async () => {
    const h = await makeApi();

    await h.api.init();

    // Read after init — the port only exists once something is listening.
    const res = await fetch(`http://127.0.0.1:${h.managementPort}/stats`, {
      headers: { authorization: 'Bearer tok', connection: 'close' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ port: expect.any(Number), loadedApps: 0 });
  });
});

describe('NexxusApi — ACL role loading', () => {
  const aclAppDoc = (overrides: Record<string, unknown> = {}): NexxusApplication => makeAuthApp({
    auth: {
      strategies: { local: {} }, userDetailSchema: { default: {} }, acl: true,
      ...(overrides.auth as object ?? {}),
    },
    ...overrides,
  });

  it('attaches the framework default role to every ACL-enabled app', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local' ] } });
    const app = aclAppDoc();

    dbState.searchImpl = (o) => (o.type === 'application' ? [ app ] : []);

    await api.init();

    expect(app.getRoleManager(DEFAULT_ACL_ROLE_ID)).toBeDefined();
  });

  it('does not query roles for an app with ACLs disabled', async () => {
    const { api } = await makeApi();

    dbState.searchImpl = (o) => (o.type === 'application' ? [ appDoc() ] : []);

    await api.init();

    // One query per ACL-enabled app, and this app isn't one.
    expect(dbState.searchCalls.filter(c => c.type === 'acl')).toHaveLength(0);
  });

  it('refuses to let a persisted role override the default', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local' ] } });
    const app = aclAppDoc();

    dbState.searchImpl = (o) => (o.type === 'application'
      ? [ app ]
      : [ aclRole(DEFAULT_ACL_ROLE_ID, [ { effect: 'Deny', action: [ '*' ], resource: [ '*' ] } ]) ]);

    await api.init();

    // Taking the persisted one would let an app lock itself out of its own
    // default, so the in-memory default always wins — loudly.
    expect(logger.has('warning', /cannot be overridden/)).toBe(true);
    expect(app.getRoleManager(DEFAULT_ACL_ROLE_ID)).toBeDefined();
  });

  it('loads the app\'s own roles alongside the default', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local' ] } });
    const app = aclAppDoc({
      auth: { strategies: { local: {} }, userDetailSchema: { default: {} }, acl: true, userTypes: { admin: { roles: [ 'Auditor' ] } } },
    });

    dbState.searchImpl = (o) => (o.type === 'application'
      ? [ app ]
      : [ aclRole('Auditor', [ { effect: 'Allow', action: [ 'read' ], resource: [ '*' ] } ]) ]);

    await api.init();

    expect(app.getRoleManager('Auditor')).toBeDefined();
  });

  /**
   * A typo in `userTypes[*].roles` would otherwise surface as a silent denial
   * on the first request from that user type, which is a miserable thing to
   * debug. Boot is the right place to find out.
   */
  it('refuses to start when a user type names a role that does not exist', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local' ] } });

    dbState.searchImpl = (o) => (o.type === 'application'
      ? [ aclAppDoc({
        auth: {
          strategies: { local: {} }, userDetailSchema: { default: {} }, acl: true,
          userTypes: { admin: { roles: [ 'TypoedRole' ] } },
        },
      }) ]
      : []);

    await expect(api.init()).rejects.toThrow(/references unknown ACL role "TypoedRole"/);
  });
});

describe('NexxusApi — auth strategy registration', () => {
  it('resolves the built-in strategies without a dynamic import', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local', 'google' ] } });

    await api.init();

    expect(api.hasAuthStrategy('local')).toBe(true);
    expect(api.hasAuthStrategy('google')).toBe(true);
    expect(api.hasAuthStrategy('facebook')).toBe(false);
  });

  it('warns and no-ops on a duplicate name', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local', 'local' ] } });

    await api.init();

    expect(logger.has('warning', /Auth strategy already registered: local/)).toBe(true);
    expect((await api.getStats()).authStrategies).toEqual([ 'local' ]);
  });

  it('gives an actionable error for a strategy package that is not installed', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ '@nope/not-installed' ] } });

    // "is it installed?" rather than ERR_MODULE_NOT_FOUND.
    await expect(api.init()).rejects.toThrow(InvalidConfigException);
    await expect(makeApi({ auth: { availableStrategies: [ '@nope/not-installed' ] } })
      .then(h => h.api.init())).rejects.toThrow(/make sure it's installed/);
  });

  it('instantiates one strategy per application', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local' ] } });

    dbState.searchImpl = (o) => (o.type === 'application'
      ? [ makeAuthApp(), makeAuthApp({ id: 'app2' }) ]
      : []);

    await api.init();

    const first = api.getAppAuthStrategy('app1', 'local');
    const second = api.getAppAuthStrategy('app2', 'local');

    expect(first).toBeInstanceOf(NexxusLocalAuthStrategy);
    // Isolated per tenant — OAuth config varies per application.
    expect(second).not.toBe(first);
    expect(api.getAppAuthStrategy('app1', 'google')).toBeUndefined();
  });

  it('instantiates the right class per strategy name', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local', 'google' ] } });

    dbState.searchImpl = (o) => (o.type === 'application'
      ? [ makeAuthApp({ auth: { strategies: { local: {}, google: GOOGLE_CONFIG }, userDetailSchema: { default: {} } } }) ]
      : []);

    await api.init();

    expect(api.getAppAuthStrategy('app1', 'local')).toBeInstanceOf(NexxusLocalAuthStrategy);
    expect(api.getAppAuthStrategy('app1', 'google')).toBeInstanceOf(NexxusGoogleAuthStrategy);
  });

  it('refuses to start when an app declares a strategy the deployment lacks', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local' ] } });

    dbState.searchImpl = (o) => (o.type === 'application'
      ? [ makeAuthApp({ auth: { strategies: { google: GOOGLE_CONFIG }, userDetailSchema: { default: {} } } }) ]
      : []);

    await expect(api.init()).rejects.toThrow(/not in api.auth.availableStrategies/);
  });

  it('refuses to start on a malformed per-app strategy config', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'google' ] } });

    dbState.searchImpl = (o) => (o.type === 'application'
      ? [ makeAuthApp({ auth: { strategies: { google: { clientID: 'only-this' } }, userDetailSchema: { default: {} } } }) ]
      : []);

    // The strategy's own AJV validation fires in its constructor, so bad config
    // is a boot failure rather than a surprise on the first login.
    await expect(api.init()).rejects.toThrow(/Invalid config for auth strategy/);
  });

  it('hands each app the detail namespaces its strategies own', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'google' ] } });
    const app = makeAuthApp({ auth: { strategies: { google: GOOGLE_CONFIG }, userDetailSchema: { default: {} } } });

    dbState.searchImpl = (o) => (o.type === 'application' ? [ app ] : []);

    await api.init();

    // The merge core can't do for itself — it has no knowledge of strategy
    // classes.
    expect(app.getUserDetailSchema('default')).toHaveProperty(authDetailKey('google'));
  });

  it('contributes no namespace for a strategy that learns nothing', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local' ] } });
    const app = makeAuthApp();

    dbState.searchImpl = (o) => (o.type === 'application' ? [ app ] : []);

    await api.init();

    expect(app.getUserDetailSchema('default')).toEqual({});
  });
});

describe('NexxusApi — auth routes', () => {
  async function serveWithStrategies(strategies: Record<string, unknown>, available: string[]): Promise<Harness> {
    const h = await makeApi({ auth: { availableStrategies: available } });

    dbState.searchImpl = (o) => (o.type === 'application'
      ? [ makeAuthApp({ auth: { strategies, userDetailSchema: { default: {} } } }) ]
      : []);

    await h.api.init();

    return h;
  }

  it('registers POST /auth/<name> for a registered strategy', async () => {
    const { request } = await serveWithStrategies({ local: {} }, [ 'local' ]);

    const res = await request('/auth/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'nxx-app-id': 'app1' },
      body: JSON.stringify({}),
    });

    // Reached the strategy: missing credentials, not a missing route.
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Username and password are required');
  });

  it('registers no callback route for a strategy that needs none', async () => {
    const { request } = await serveWithStrategies({ local: {} }, [ 'local' ]);

    expect((await request('/auth/local/callback')).status).toBe(404);
  });

  it('registers the callback route for an OAuth strategy', async () => {
    const { request } = await serveWithStrategies({ google: GOOGLE_CONFIG }, [ 'google' ]);

    const res = await request('/auth/google/callback');

    // Reached the handler and was rejected on its own terms.
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Missing state parameter');
  });

  it('rejects a callback whose state is not readable', async () => {
    const { request } = await serveWithStrategies({ google: GOOGLE_CONFIG }, [ 'google' ]);

    const res = await request('/auth/google/callback?state=not-a-state');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Malformed state parameter');
  });

  /**
   * The appId read out of the callback state is UNVERIFIED — it only selects
   * which application's key to check the signature against. A forged one picks
   * an application that has no such strategy, and stops here.
   */
  it('404s a callback whose state names an application without that strategy', async () => {
    const { request } = await serveWithStrategies({ google: GOOGLE_CONFIG }, [ 'google' ]);
    const forged = Buffer.from(JSON.stringify({ appId: 'ghost', userType: 'default', nonce: 'n' }))
      .toString('base64url');

    const res = await request(`/auth/google/callback?state=${forged}.mac`);

    expect(res.status).toBe(404);
  });

  it('404s an auth route for an application that has not configured it', async () => {
    const h = await makeApi({ auth: { availableStrategies: [ 'local', 'google' ] } });

    dbState.searchImpl = (o) => (o.type === 'application'
      ? [ makeAuthApp({ auth: { strategies: { local: {} }, userDetailSchema: { default: {} } } }) ]
      : []);

    await h.api.init();

    const res = await h.request('/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'nxx-app-id': 'app1' },
      body: JSON.stringify({}),
    });

    // Says "not available for this application", never "the deployment doesn't
    // support it" — that would leak deployment shape to a tenant.
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not available for this application/);
  });

  it('registers no auth routes at all when no strategies are configured', async () => {
    const { api, request } = await makeApi();

    await api.init();

    expect((await request('/auth/local', { method: 'POST' })).status).toBe(404);
  });
});

describe('NexxusApi.getStats', () => {
  it('reports in-process state', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'local' ] } });

    dbState.searchImpl = (o) => (o.type === 'application' ? [ makeAuthApp() ] : []);

    await api.init();

    expect(await api.getStats()).toMatchObject({
      port: expect.any(Number),
      uptime: expect.any(Number),
      loadedApps: 1,
      authStrategies: [ 'local' ],
      authEnabled: true,
      logger: { transports: [] },
    });
  });

  it('reports authEnabled false when no strategy class is registered', async () => {
    const { api } = await makeApi();

    await api.init();

    expect(await api.getStats()).toMatchObject({ authEnabled: false, authStrategies: [] });
  });
});

describe('NexxusApi.close', () => {
  it('releases the API port', async () => {
    const h = await makeApi();

    await h.api.init();

    const port = h.port;

    expect(port).toBeGreaterThan(0);
    await h.api.close();

    // Refusing connections is the observable difference between "closed" and
    // "reported as closed" — `close()` must not resolve before the socket is
    // actually gone, or a restart races its own predecessor.
    await expect(fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' } }))
      .rejects.toThrow();
  });

  it('releases the management port', async () => {
    const h = await makeApi();

    await h.api.init();

    const port = h.managementPort;

    expect(port).toBeGreaterThan(0);
    await h.api.close();

    await expect(fetch(`http://127.0.0.1:${port}/stats`, { headers: { connection: 'close' } }))
      .rejects.toThrow();
  });

  it('disconnects every upstream', async () => {
    const { api, db, mq, redis } = await makeApi();
    const closed: string[] = [];

    db.disconnect = async () => { closed.push('db'); };
    mq.disconnect = async () => { closed.push('mq'); };
    redis.close = async () => { closed.push('redis'); };

    await api.init();
    await api.close();

    expect(closed.sort()).toEqual([ 'db', 'mq', 'redis' ]);
  });

  it('closes the others even when one upstream refuses', async () => {
    const { api, db, mq, redis } = await makeApi();
    const closed: string[] = [];

    db.disconnect = async () => { throw new Error('broker is wedged'); };
    mq.disconnect = async () => { closed.push('mq'); };
    redis.close = async () => { closed.push('redis'); };

    await api.init();
    await expect(api.close()).resolves.toBeUndefined();

    // One sticky client must not strand the rest of the shutdown.
    expect(closed.sort()).toEqual([ 'mq', 'redis' ]);
    expect(logger.has('warning', /"database" failed to close cleanly: broker is wedged/)).toBe(true);
  });

  it('is safe to call without ever having been initialized', async () => {
    const { api } = await makeApi();

    await expect(api.close()).resolves.toBeUndefined();
  });
});

/**
 * Hub registration, against a REAL HTTP endpoint standing in for Hub.
 *
 * Hub is a service the API talks to over HTTP, so the honest stand-in is a
 * server that speaks its two routes — stubbing `NexxusHubClient` would skip the
 * retry loop and the payload shape, which is most of what there is to get
 * wrong here.
 */
describe('NexxusApi — Hub registration', () => {
  let hub: TestServer;
  let registered: any[];
  let unregistered: string[];
  let rejectRequests: boolean;

  beforeEach(async () => {
    registered = [];
    unregistered = [];
    rejectRequests = false;

    hub = await startTestServer(app => {
      app.post('/node', ((req, res) => {
        if (rejectRequests) {
          return void res.status(500).json({ error: 'hub is down' });
        }

        registered.push(req.body);
        res.status(200).json(req.body);
      }) as never);

      app.delete('/node/:id', ((req, res) => {
        if (rejectRequests) {
          return void res.status(500).json({ error: 'hub is down' });
        }

        unregistered.push(req.params.id);
        res.status(200).json({});
      }) as never);
    });
  });

  afterEach(async () => { await hub.close(); });

  const withHub = () => makeApi({ hub: { endpoint: hub.url, token: 'hub-token' } });

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for Hub traffic');

      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  it('registers itself after init, carrying its role and stats', async () => {
    const { api } = await withHub();

    await api.init();
    await waitFor(() => registered.length > 0);

    expect(registered[0]).toMatchObject({
      role: 'api',
      id: expect.any(String),
      stats: { loadedApps: 0, port: expect.any(Number) },
    });
    expect(logger.has('info', /Registered with Hub as /)).toBe(true);
  });

  it('does not block init on Hub being reachable', async () => {
    rejectRequests = true;

    const { api } = await withHub();

    // Hub is a soft dependency: a node whose registration is still retrying
    // must still be serving requests.
    await expect(api.init()).resolves.toBeUndefined();
    expect((await api.getStats()).loadedApps).toBe(0);
  });

  it('unregisters on close', async () => {
    const { api } = await withHub();

    await api.init();
    await waitFor(() => registered.length > 0);
    await api.close();

    expect(unregistered).toEqual([ registered[0].id ]);
    expect(logger.has('info', /Unregistered from Hub/)).toBe(true);
  });

  it('closes cleanly when Hub refuses the de-registration', async () => {
    const { api } = await withHub();

    await api.init();
    await waitFor(() => registered.length > 0);

    rejectRequests = true;

    // Registry drift heals on the next Hub restart, so a failure here is
    // logged and swallowed rather than obstructing shutdown.
    await expect(api.close()).resolves.toBeUndefined();
    expect(logger.has('warning', /leaving entry to leak/)).toBe(true);
  });

  it('sends nothing to Hub when it never managed to register', async () => {
    rejectRequests = true;

    const { api } = await withHub();

    await api.init();
    await api.close();

    expect(unregistered).toEqual([]);
  });

  it('runs standalone when no Hub is configured', async () => {
    const { api } = await makeApi();

    await api.init();
    await api.close();

    expect(registered).toEqual([]);
  });
});

describe('NexxusApi — third-party auth strategy packages', () => {
  it('rejects a package whose export is not an auth strategy class', async () => {
    // `express` imports fine and default-exports a function, so it gets past
    // the "is there a class here" check and fails the one that matters.
    const { api } = await makeApi({ auth: { availableStrategies: [ 'express' ] } });

    await expect(api.init()).rejects.toThrow(/must extend NexxusAuthStrategy/);
  });

  it('rejects a package that exports no class at all', async () => {
    const { api } = await makeApi({ auth: { availableStrategies: [ 'bcrypt' ] } });

    await expect(api.init()).rejects.toThrow(/must default-export a class extending NexxusAuthStrategy/);
  });
});

describe('NexxusApi — service resolution', () => {
  it('registers a resolved factory service with the config manager', async () => {
    const registeredClasses: unknown[] = [];
    const configManager = { registerService: (c: unknown) => registeredClasses.push(c) };

    const cls = await NexxusApi.resolveFactoryService(configManager as never, 'WinstonNexxusLogger');

    // Registration is the point: the next `validateServices()` has to see the
    // resolved class's schema, or its config section is unvalidated.
    expect(cls).toBeTypeOf('function');
    expect(registeredClasses).toEqual([ cls ]);
  });

  it('registers a resolved constructable service with the config manager', async () => {
    const registeredClasses: unknown[] = [];
    const configManager = { registerService: (c: unknown) => registeredClasses.push(c) };

    const cls = await NexxusApi.resolveConstructableService(configManager as never, 'NexxusElasticsearchDb');

    expect(cls).toBeTypeOf('function');
    expect(registeredClasses).toEqual([ cls ]);
  });
});

describe('NexxusApi — accessors', () => {
  it('hands back the config it was constructed with', async () => {
    const { api } = await makeApi({ name: 'named-api' });

    expect(api.getConfig()).toMatchObject({ name: 'named-api' });
  });

  it('returns undefined for an application it never loaded', async () => {
    const { api } = await makeApi();

    await api.init();

    expect(NexxusApi.getStoredApp('ghost')).toBeUndefined();
  });
});

