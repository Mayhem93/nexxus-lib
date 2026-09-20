import { vi } from 'vitest';
import { NexxusBaseLogger } from '@mayhem93/nexxus-core-lib';
import { NexxusDatabaseAdapter, type NexxusDatabaseAdapterEvents } from '@mayhem93/nexxus-database-lib';
import { NexxusMessageQueueAdapter, type NexxusQueueMessage } from '@mayhem93/nexxus-message-queue-lib';
import { NexxusRedis } from '@mayhem93/nexxus-redis';
import type { NexxusApplication, NexxusAclRole, INexxusBaseServices } from '@mayhem93/nexxus-core-lib';
import { FakeRedis } from '../redis/fakeRedis';

import * as net from 'node:net';

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
  applications: NexxusApplication[];
  aclRoles: Record<string, NexxusAclRole[]>;
  connectImpl: (() => Promise<void>) | null;
  disconnectImpl: (() => Promise<void>) | null;
  searchCalls: any[];
  created: any[][];
  deleted: any[][];
  updateCalls: Array<{ patches: any[]; options: any }>;
  updateResult: any[];
} = {
  applications: [], aclRoles: {}, connectImpl: null, disconnectImpl: null, searchCalls: [],
  created: [], deleted: [], updateCalls: [], updateResult: [],
};

export class FakeDb extends NexxusDatabaseAdapter<any, NexxusDatabaseAdapterEvents> {
  public async connect(): Promise<void> {
    if (dbState.connectImpl) await dbState.connectImpl();

    this.emit('connect');
  }

  public async disconnect(): Promise<void> {
    if (dbState.disconnectImpl) await dbState.disconnectImpl();
  }

  public getBootstrapper(): never { return undefined as never; }

  public async createItems(collection: any[]): Promise<void> { dbState.created.push(collection); }

  public async getItems(): Promise<any> { return []; }

  public async searchItems(options: any): Promise<any> {
    dbState.searchCalls.push(options);

    if (options.type === 'application') return dbState.applications;
    if (options.type === 'acl') return dbState.aclRoles[options.appId] ?? [];

    return [];
  }

  public async updateItems(patches: any[], options: any): Promise<any> {
    dbState.updateCalls.push({ patches, options });

    return dbState.updateResult;
  }

  public async deleteItems(collection: any[]): Promise<void> { dbState.deleted.push(collection); }
  public async countItems(): Promise<number> { return 0; }
  protected buildQuery(): object { return {}; }
  public async getStats(): Promise<any> { return {}; }
}

/* ------------------------------------------------------------------ *
 * Fake MQ adapter (real base → real connection state machine)         *
 * ------------------------------------------------------------------ */
export const mqState: {
  connectImpl: (() => void) | null;
  consumed: Array<{ queue: string; cb: any }>;
  published: Array<{ queue: string; message: any; metadata?: any }>;
  queueExistsResult: boolean;
  createdQueues: string[];
  deletedQueues: string[];
  deleteQueueImpl: (() => Promise<void>) | null;
} = {
  connectImpl: null, consumed: [], published: [], queueExistsResult: false,
  createdQueues: [], deletedQueues: [], deleteQueueImpl: null,
};

export class FakeMq extends NexxusMessageQueueAdapter<any, any, any> {
  protected reconnectDelayMs = 5;

  protected async doConnect(): Promise<void> {
    if (mqState.connectImpl) mqState.connectImpl();
  }

  protected async doDisconnect(): Promise<void> {}
  protected isFatalConnectError(): boolean { return false; }

  protected async doConsume(queueName: string, cb: (m: NexxusQueueMessage<any>) => Promise<void>): Promise<void> {
    mqState.consumed.push({ queue: queueName, cb });
  }

  protected async doCancelAll(): Promise<void> {}
  public getBootstrapper(): never { return undefined as never; }

  public async publishMessage(queueName: any, message: any, metadata?: any): Promise<void> {
    mqState.published.push({ queue: queueName, message, metadata });
  }

  public async queueExists(): Promise<boolean> { return mqState.queueExistsResult; }

  public async createVolatileQueue(name: string): Promise<void> { mqState.createdQueues.push(name); }

  public async deleteQueue(name: string): Promise<void> {
    if (mqState.deleteQueueImpl) await mqState.deleteQueueImpl();

    mqState.deletedQueues.push(name);
  }

  public async getStats(): Promise<any> { return { id: 'fake-mq' }; }
}

/* ------------------------------------------------------------------ *
 * Services + helpers                                                  *
 * ------------------------------------------------------------------ */
export type WorkerHarness = {
  services: any;
  db: FakeDb;
  mq: FakeMq;
  redis: NexxusRedis;
  redisClient: FakeRedis;
  port: number;
};

/**
 * ONE shared in-memory redis client for the whole worker test file.
 *
 * Every suite's module-level `beforeEach` registers on the test file's root
 * suite, so all of them run before every test (in import order) and each would
 * otherwise construct a NexxusRedis that overwrites the `NexxusRedis.instance`
 * static — leaving `NexxusDevice` reading a different client than the suite
 * under test seeded. Sharing one client makes that ordering irrelevant. The
 * NexxusRedis wrapper itself stays per-harness so event listeners don't pile up.
 */
const sharedRedisClient = new FakeRedis();

/** Clear stored data and drop any per-test method overrides (tests shadow methods to force errors). */
function resetRedisClient(): void {
  for (const key of Object.getOwnPropertyNames(sharedRedisClient)) {
    if (key !== 'store' && key !== 'json') {
      delete (sharedRedisClient as unknown as Record<string, unknown>)[key];
    }
  }

  sharedRedisClient.store.clear();
}

/** Ask the OS for a free port (for the management server). */
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
 * Build the four worker services. The redis service is a REAL NexxusRedis
 * (instanceof + the NexxusRedis.instance static that NexxusDevice needs) with
 * init/close/getClient overridden so no real client is ever created.
 */
export async function makeHarness(appConfigOverrides: Record<string, unknown> = {}): Promise<WorkerHarness> {
  logger.entries = [];
  Object.assign(dbState, {
    applications: [], aclRoles: {}, connectImpl: null, disconnectImpl: null, searchCalls: [],
    created: [], deleted: [], updateCalls: [], updateResult: [],
  });
  Object.assign(mqState, {
    connectImpl: null, consumed: [], published: [], queueExistsResult: false,
    createdQueues: [], deletedQueues: [], deleteQueueImpl: null,
  });

  const port = await getFreePort();
  const appConfig = {
    management: { port, token: 'tok' },
    ...appConfigOverrides,
  };

  const configManager = {
    getConfig: (key: string) => {
      if (key === 'app') return appConfig;

      return {}; // database / message_queue / redis sections
    },
  };

  const baseServices = { configManager, logger } as unknown as INexxusBaseServices;

  resetRedisClient();

  const db = new FakeDb(baseServices);
  const mq = new FakeMq(baseServices);
  const redis = new NexxusRedis(baseServices);
  const redisClient = sharedRedisClient;

  redis.init = async () => { redis.emit('connect'); };
  redis.close = async () => {};
  redis.getClient = () => redisClient as never;

  return {
    services: { configManager, logger, database: db, messageQueue: mq, redis },
    db, mq, redis, redisClient, port,
  };
}

/** Clear the process-wide statics BaseWorker keeps (loadedApps leaks across tests otherwise). */
export function resetWorkerStatics(BaseWorkerClass: any): void {
  (BaseWorkerClass.loadedApps as Map<string, unknown>).clear();
}

export { vi };
