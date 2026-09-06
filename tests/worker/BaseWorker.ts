import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { NexxusApplication, NexxusAclRole, DEFAULT_ACL_ROLE_ID, WinstonNexxusLogger } from '@mayhem93/nexxus-core-lib';
import { NexxusElasticsearchDb } from '@mayhem93/nexxus-database-lib';
import { NexxusRabbitMq } from '@mayhem93/nexxus-message-queue-lib';
import { makeHarness, logger, dbState, mqState, resetWorkerStatics, type WorkerHarness } from './harness';

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

class FakeWorker extends NexxusBaseWorker<any> {
  protected queueName: any = 'writer';
  protected nodeRole = 'writer';
  public processed: any[] = [];

  protected async processMessage(msg: any): Promise<void> { this.processed.push(msg); }

  /** Escape hatch for reaching protected/private internals in tests. */
  public any(): any { return this; }
}

class StatsWorker extends FakeWorker {
  protected async getOwnStats(): Promise<any> { return { custom: 42 }; }
}

const workers: NexxusBaseWorker<any>[] = [];
let h: WorkerHarness;

beforeEach(async () => {
  resetWorkerStatics(NexxusBaseWorker);
  h = await makeHarness();
});

afterEach(async () => {
  for (const w of workers) await w.close().catch(() => {});
  workers.length = 0;
});

const worker = (Cls: typeof FakeWorker = FakeWorker, services = h.services): FakeWorker => {
  const w = new Cls(services);

  workers.push(w);

  return w;
};

/* --- fixtures --------------------------------------------------------- */
const aclApp = (userTypes?: Record<string, unknown>) => new NexxusApplication({
  id: 'app1', type: 'application', name: 'A',
  schema: { runs: { fields: { note: { type: 'string' } } } },
  auth: { jwtSecret: 's', strategies: { local: {} }, userDetailSchema: { default: {} }, acl: true, ...(userTypes ? { userTypes } : {}) },
} as never);

const plainApp = (id = 'app2') => new NexxusApplication({
  id, type: 'application', name: 'B', schema: { runs: { fields: { note: { type: 'string' } } } },
} as never);

const aclRole = (id: string) => new NexxusAclRole({
  id, appId: 'app1', statements: JSON.stringify([{ effect: 'Allow', action: ['read'], resource: ['runs'] }]),
} as never);

describe('NexxusBaseWorker construction guards', () => {
  it('rejects services that are not the expected base classes', () => {
    expect(() => worker(FakeWorker, { ...h.services, logger: {} })).toThrow(/Logger service is not an instance/);
    expect(() => worker(FakeWorker, { ...h.services, database: {} })).toThrow(/Database service is not an instance/);
    expect(() => worker(FakeWorker, { ...h.services, messageQueue: {} })).toThrow(/Message Queue service is not an instance/);
    expect(() => worker(FakeWorker, { ...h.services, redis: {} })).toThrow(/Redis service is not an instance/);
  });
});

describe('NexxusBaseWorker upstream availability', () => {
  it('is unavailable until all three services connect', () => {
    const w = worker();

    expect(w.isAvailable).toBe(false);

    h.db.emit('connect');
    h.mq.emit('connect');
    expect(w.isAvailable).toBe(false);

    h.redis.emit('connect');
    expect(w.isAvailable).toBe(true);
  });

  it('resumes MQ consumption once everything is up (and is idempotent per service)', () => {
    const w = worker();
    const resume = vi.spyOn(h.mq, 'resumeConsuming');

    h.db.emit('connect');
    h.mq.emit('connect');
    h.redis.emit('connect');
    h.redis.emit('connect'); // duplicate — must not re-trigger

    expect(w.isAvailable).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('pauses consumption on the availability→unavailability edge only', () => {
    worker();
    const pause = vi.spyOn(h.mq, 'pauseConsuming');

    h.db.emit('connect');
    h.mq.emit('connect');
    h.redis.emit('connect');

    h.db.emit('disconnect');    // edge → pause
    h.mq.emit('disconnect');    // already unavailable → no second pause

    expect(pause).toHaveBeenCalledTimes(1);
    expect(logger.has('warning', /Upstream service "db" disconnected/)).toBe(true);
  });

  it('stays quiet about disconnects once closing', async () => {
    const w = worker();

    h.db.emit('connect');
    h.mq.emit('connect');
    h.redis.emit('connect');

    await w.close();
    logger.entries = [];

    const pause = vi.spyOn(h.mq, 'pauseConsuming');

    h.db.emit('disconnect');

    expect(pause).not.toHaveBeenCalled();
    expect(logger.has('warning', /disconnected/)).toBe(false);
  });

  it('ignores a disconnect for a service that was never up', () => {
    worker();

    h.db.emit('disconnect'); // never connected → early return, nothing logged

    expect(logger.has('warning', /disconnected/)).toBe(false);
  });

  it('warns when pauseConsuming rejects', async () => {
    worker();

    h.db.emit('connect');
    h.mq.emit('connect');
    h.redis.emit('connect');

    vi.spyOn(h.mq, 'pauseConsuming').mockRejectedValueOnce(new Error('pause boom'));
    h.db.emit('disconnect');

    await tick();

    expect(logger.has('warning', /pauseConsuming failed: pause boom/)).toBe(true);
  });

  it('warns when resumeConsuming rejects', async () => {
    worker();

    vi.spyOn(h.mq, 'resumeConsuming').mockRejectedValueOnce(new Error('resume boom'));

    h.db.emit('connect');
    h.mq.emit('connect');
    h.redis.emit('connect');

    await tick();

    expect(logger.has('warning', /resumeConsuming failed: resume boom/)).toBe(true);
  });
});

describe('NexxusBaseWorker init / close', () => {
  it('connects upstreams, loads apps, wires the consumer and serves management stats', async () => {
    dbState.applications = [plainApp('appA'), plainApp('appB')];

    const w = worker();

    await w.init();

    // consumer wired to our queue
    expect(mqState.consumed[0].queue).toBe('writer');
    // apps loaded into the shared static
    expect((NexxusBaseWorker as any).loadedApps.size).toBe(2);

    const res = await fetch(`http://127.0.0.1:${h.port}/stats`, { headers: { Authorization: 'Bearer tok' } });
    const stats = await res.json();

    expect(res.status).toBe(200);
    expect(stats).toMatchObject({ queueName: 'writer', loadedApps: 2, initialized: true });
  });

  it('proceeds straight through the availability gate when everything is already up', async () => {
    const w = worker();

    h.db.emit('connect');
    h.mq.emit('connect');
    h.redis.emit('connect');
    expect(w.isAvailable).toBe(true);

    await w.init(); // waitUntilAllConnected resolves immediately

    expect(mqState.consumed).toHaveLength(1);
  });

  it('close() stops the management server and disconnects every upstream', async () => {
    const w = worker();

    await w.init();

    const dbSpy = vi.spyOn(h.db, 'disconnect');
    const mqSpy = vi.spyOn(h.mq, 'disconnect');
    const redisSpy = vi.spyOn(h.redis, 'close');

    await w.close();

    expect(dbSpy).toHaveBeenCalled();
    expect(mqSpy).toHaveBeenCalled();
    expect(redisSpy).toHaveBeenCalled();

    await tick(30);
    await expect(fetch(`http://127.0.0.1:${h.port}/stats`, { headers: { Authorization: 'Bearer tok' } })).rejects.toThrow();
  });

  it('warns when an upstream fails to close cleanly', async () => {
    const w = worker();

    await w.init();
    vi.spyOn(h.db, 'disconnect').mockRejectedValueOnce(new Error('stuck'));

    await w.close();

    expect(logger.has('warning', /Upstream service "database" failed to close cleanly: stuck/)).toBe(true);
  });
});

describe('NexxusBaseWorker stats + publish', () => {
  it('reports the baseline stats', async () => {
    const w = worker();
    const stats = await w.getStats();

    expect(stats).toMatchObject({ queueName: 'writer', loadedApps: 0, initialized: false });
    expect(typeof stats.uptime).toBe('number');
    expect(stats.logger).toEqual({ transports: [] });
  });

  it('merges a subclass getOwnStats() without losing the baseline', async () => {
    const stats = await worker(StatsWorker).getStats();

    expect(stats).toMatchObject({ custom: 42, queueName: 'writer', initialized: false });
  });

  it('publish() delegates to the message queue', async () => {
    await worker().any().publish('writer', { event: 'x' }, { meta: 1 });

    expect(mqState.published[0]).toEqual({ queue: 'writer', message: { event: 'x' }, metadata: { meta: 1 } });
  });
});

describe('NexxusBaseWorker Hub registration', () => {
  it('is a no-op without a hub config', async () => {
    const w = worker();

    await w.init();

    expect(w.any().hubClient).toBeNull();
    expect(w.any().nodeId).toBeNull();
  });

  it('records the node id on a successful register', async () => {
    const w = worker();
    let built: any;

    w.any().hubClient = {
      registerNode: async (build: () => Promise<any>) => { built = await build(); return built; },
      unregisterNode: async () => {},
      dispose: () => {},
    };

    w.any().registerWithHub();
    await tick();

    expect(w.any().nodeId).toBe(built.id);
    expect(built).toMatchObject({ role: 'writer', managementPort: h.port });
    expect(typeof built.privateIpAddress).toBe('string');
    expect(built.stats).toMatchObject({ queueName: 'writer' });
    expect(logger.has('info', /Registered with Hub/)).toBe(true);
  });

  it('warns when registration is abandoned', async () => {
    const w = worker();

    w.any().hubClient = {
      registerNode: async () => { throw new Error('disposed'); },
      unregisterNode: async () => {},
      dispose: () => {},
    };

    w.any().registerWithHub();
    await tick();

    expect(logger.has('warning', /Hub registration abandoned: disposed/)).toBe(true);
  });

  it('unregisters on close, and swallows+warns a failing de-register', async () => {
    const w = worker();
    const unregistered: string[] = [];

    w.any().hubClient = {
      registerNode: async () => ({ id: 'node-1' }),
      unregisterNode: async (id: string) => { unregistered.push(id); },
      dispose: () => {},
    };
    w.any().nodeId = 'node-1';

    await w.close();

    expect(unregistered).toEqual(['node-1']);
    expect(logger.has('info', /Unregistered from Hub/)).toBe(true);
  });

  it('warns when de-registration fails', async () => {
    const w = worker();

    w.any().hubClient = {
      registerNode: async () => ({ id: 'n' }),
      unregisterNode: async () => { throw new Error('hub gone'); },
      dispose: () => {},
    };
    w.any().nodeId = 'node-1';

    await w.close();

    expect(logger.has('warning', /Failed to unregister from Hub.*hub gone/)).toBe(true);
    expect(w.any().nodeId).toBeNull();
  });
});

describe('NexxusBaseWorker service resolvers', () => {
  const cm = () => ({ registerService: vi.fn() });

  it('resolves the builtin factory service (logger) and registers its schema', async () => {
    const configManager = cm();

    const cls = await NexxusBaseWorker.resolveFactoryService(configManager as never, 'WinstonNexxusLogger');

    expect(cls).toBe(WinstonNexxusLogger);
    expect(configManager.registerService).toHaveBeenCalledWith(WinstonNexxusLogger);
  });

  it('resolves the builtin constructable services (db + mq) and registers them', async () => {
    const configManager = cm();

    expect(await NexxusBaseWorker.resolveConstructableService(configManager as never, 'NexxusElasticsearchDb')).toBe(NexxusElasticsearchDb);
    expect(await NexxusBaseWorker.resolveConstructableService(configManager as never, 'NexxusRabbitMq')).toBe(NexxusRabbitMq);
    expect(configManager.registerService).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown service name (not a builtin, not installed)', async () => {
    await expect(NexxusBaseWorker.resolveConstructableService(cm() as never, 'nope-not-a-package-xyz'))
      .rejects.toThrow(/could not be resolved/);
  });
});

describe('NexxusBaseWorker.loadApps / loadAclRoles', () => {
  const loadApps = () => (NexxusBaseWorker as any).loadApps();

  it('loads applications into the shared registry', async () => {
    worker(); // sets the static db/logger
    dbState.applications = [plainApp('appA'), plainApp('appB')];

    await loadApps();

    expect((NexxusBaseWorker as any).loadedApps.size).toBe(2);
    expect(logger.has('info', /Loaded 2 applications/)).toBe(true);
  });

  it('attaches the default role manager plus each persisted role', async () => {
    worker();

    const app = aclApp({ driver: { roles: ['DriverRole'] } });

    dbState.applications = [app];
    dbState.aclRoles = { app1: [aclRole('DriverRole')] };

    await loadApps();

    expect(app.getRoleManager(DEFAULT_ACL_ROLE_ID)).toBeDefined();
    expect(app.getRoleManager('DriverRole')).toBeDefined();
    expect(logger.has('info', /Loaded 2 ACL role\(s\) for app "app1"/)).toBe(true);
  });

  it('ignores a persisted role that reuses the default role id', async () => {
    worker();

    const app = aclApp();

    dbState.applications = [app];
    dbState.aclRoles = { app1: [aclRole(DEFAULT_ACL_ROLE_ID)] };

    await loadApps();

    expect(logger.has('warning', new RegExp(`Ignoring role "${DEFAULT_ACL_ROLE_ID}"`))).toBe(true);
    expect(app.getRoleManagers().size).toBe(1); // only the framework default
  });

  it('fails fast when a user type references an unknown role', async () => {
    worker();

    dbState.applications = [aclApp({ driver: { roles: ['Missing'] } })];
    dbState.aclRoles = { app1: [] };

    await expect(loadApps()).rejects.toThrow(/references unknown ACL role "Missing"/);
  });

  it('skips ACL loading entirely for apps without ACLs', async () => {
    worker();
    dbState.applications = [plainApp('appA')];

    await loadApps();

    expect(dbState.searchCalls.filter(c => c.type === 'acl')).toHaveLength(0);
  });
});
