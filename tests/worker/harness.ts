import { vi } from 'vitest';
import { NexxusBaseLogger } from '@mayhem93/nexxus-core-lib';
import { NexxusDatabaseAdapter, type NexxusDatabaseAdapterEvents } from '@mayhem93/nexxus-database-lib';
import { NexxusMessageQueueAdapter, type NexxusMessageDelivery } from '@mayhem93/nexxus-message-queue-lib';
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
  /** The options each `deleteItems` call was given, in order. */
  deleteOptions: any[];
  updateCalls: Array<{ patches: any[]; options: any }>;
  /** What `updateItems` reads back, by `id`: the fields `returnFields` asks for. */
  updateResult: any[];
  /** What `deleteItems` reads back before deleting, by `id`: the fields `returnFields` asks for. */
  deleteResult: any[];
  /** Ids no document is stored under: `updateItems` and `deleteItems` answer `null` for them. */
  missingIds: string[];
} = {
  applications: [], aclRoles: {}, connectImpl: null, disconnectImpl: null, searchCalls: [],
  created: [], deleted: [], deleteOptions: [], updateCalls: [], updateResult: [], deleteResult: [], missingIds: [],
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

  /** Nothing is stored here: every requested id is reported missing. */
  public async getItems(options: any): Promise<any> {
    return new Map(options.ids.map((id: string) => [ id, null ]));
  }

  public async searchItems(options: any): Promise<any> {
    dbState.searchCalls.push(options);

    if (options.type === 'application') return dbState.applications;
    if (options.type === 'acl') return dbState.aclRoles[options.appId] ?? [];

    return [];
  }

  /** As the adapter does: keyed by document id, `null` for one in `missingIds`. */
  public async updateItems(patches: any[], options: any): Promise<any> {
    dbState.updateCalls.push({ patches, options });

    return new Map(patches.map(p => {
      const id = p.get().metadata.id;

      return [ id, dbState.missingIds.includes(id) ? null : { id, ...dbState.updateResult.find(r => r.id === id) } ];
    }));
  }

  /** As `updateItems` does; `deleteResult` is what reading `returnFields` back finds. */
  public async deleteItems(collection: any[], options?: any): Promise<any> {
    dbState.deleted.push(collection);
    dbState.deleteOptions.push(options);

    return new Map(collection.map(item => {
      const id = item.getData().id;

      return [ id, dbState.missingIds.includes(id) ? null : { id, ...dbState.deleteResult.find(r => r.id === id) } ];
    }));
  }
  public async countItems(): Promise<number> { return 0; }
  protected buildQuery(): object { return {}; }
  public async getStats(): Promise<any> { return {}; }
}

/* ------------------------------------------------------------------ *
 * Fake MQ adapter (real base → real connection state machine)         *
 * ------------------------------------------------------------------ */
export const mqState: {
  connectImpl: (() => void) | null;
  /** Every consumer registered: `deliver` is how a test hands it a message. */
  consumed: Array<{ queue: string; deliver: (delivery: NexxusMessageDelivery) => void }>;
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

  /**
   * The real adapter refuses queue operations until `connect()` has succeeded,
   * so the fake does too — a fake that answers anyway lets a test call them in
   * an order production can't, which is how a worker booting in the wrong order
   * once passed every test here.
   */
  private open = false;

  protected async doConnect(): Promise<void> {
    if (mqState.connectImpl) mqState.connectImpl();

    this.open = true;
  }

  protected async doDisconnect(): Promise<void> { this.open = false; }
  protected isFatalConnectError(): boolean { return false; }

  protected async doConsume(queueName: string, deliver: (delivery: NexxusMessageDelivery) => void): Promise<void> {
    mqState.consumed.push({ queue: queueName, deliver });
  }

  protected async doCancelAll(): Promise<void> {}
  public getBootstrapper(): never { return undefined as never; }

  /** Publishing goes through the real base; records each message as the broker would get it. */
  protected async doPublish(queueName: any, content: Buffer, metadata?: any): Promise<void> {
    mqState.published.push({ queue: queueName, message: JSON.parse(content.toString()), metadata });
  }

  public async queueExists(): Promise<boolean> {
    if (!this.open) throw new Error('FakeMq: call connect() before queueExists()');

    return mqState.queueExistsResult;
  }

  public async createVolatileQueue(name: string): Promise<void> {
    if (!this.open) throw new Error('FakeMq: call connect() before createVolatileQueue()');

    mqState.createdQueues.push(name);
  }

  public async deleteQueue(name: string): Promise<void> {
    if (!this.open) throw new Error('FakeMq: call connect() before deleteQueue()');

    if (mqState.deleteQueueImpl) await mqState.deleteQueueImpl();

    mqState.deletedQueues.push(name);
  }

  public async getStats(): Promise<any> { return { id: 'fake-mq' }; }
}

/**
 * A message as the broker would hand it to a consumer registered with the fake
 * MQ (`mqState.consumed[i].deliver(...)`), recording how it was settled.
 */
export const fakeDelivery = (payload: unknown) => {
  const delivery = {
    content: Buffer.from(JSON.stringify(payload)),
    metadata: {},
    settled: [] as string[],
    ack: (): void => { delivery.settled.push('ack'); },
    deadLetter: (): void => { delivery.settled.push('deadLetter'); },
    requeue: (): void => { delivery.settled.push('requeue'); },
    isLive: (): boolean => true,
  };

  return delivery;
};

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
    created: [], deleted: [], deleteOptions: [], updateCalls: [], updateResult: [], deleteResult: [], missingIds: [],
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
