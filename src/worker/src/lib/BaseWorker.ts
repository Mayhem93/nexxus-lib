import {
  NexxusBaseService,
  INexxusBaseServices,
  NexxusConfig,
  NexxusQueueName,
  NexxusQueuePayload,
  NexxusBaseQueuePayload,
  NexxusBaseLogger,
  NexxusConfigManager,
  NexxusConstructableServiceClass,
  NexxusFactoryServiceClass,
  NexxusManagementServer,
  FatalErrorException,
  NexxusApplication,
  MODEL_REGISTRY,
  WinstonNexxusLogger,
  resolveConstructableServiceClass,
  resolveFactoryServiceClass,
  NexxusHubClient,
  NexxusHubNode,
} from '@mayhem93/nexxus-core-lib';
import {
  NexxusDatabaseAdapter,
  NexxusDatabaseAdapterEvents,
  NexxusElasticsearchDb
} from '@mayhem93/nexxus-database-lib';
import {
  NexxusMessageQueueAdapter,
  NexxusMessageQueueAdapterEvents,
  NexxusQueueMessage,
  NexxusRabbitMq
} from '@mayhem93/nexxus-message-queue-lib';
import { NexxusRedis } from '@mayhem93/nexxus-redis';

import { randomUUID } from 'node:crypto';

export type NexxusBaseWorkerEvents = Record<string, any[]>;

export interface NexxusWorkerServices extends INexxusBaseServices {
  database: NexxusDatabaseAdapter<NexxusConfig, NexxusDatabaseAdapterEvents>;
  messageQueue: NexxusMessageQueueAdapter<NexxusConfig, NexxusMessageQueueAdapterEvents, any>;
  redis: NexxusRedis;
};

/**
 * Runtime stats surfaced by `NexxusBaseWorker.getStats()`. Reports only
 * worker-process state — the DB/MQ/Redis clients' stats are Hub's own
 * concern (Hub connects to those services directly). Logger IS nested
 * because it runs in-process with the worker.
 *
 * Concrete workers can widen this shape via the fourth template arg on
 * `NexxusBaseWorker` if they want to expose additional per-role metrics
 * (queue depth for the writer, in-flight subscriptions for the WS
 * transport, etc.). To contribute those fields, override `getOwnStats()`
 * on the subclass — the base's `getStats()` merges them into the public
 * stats output automatically, so the baseline can't be accidentally
 * dropped by a subclass forgetting to include it.
 */
export type NexxusBaseWorkerStats = {
  uptime: number;
  queueName: NexxusQueueName;
  loadedApps: number;
  initialized: boolean;
  logger: Record<string, unknown>;
};

export type NexxusBaseWorkerConfig = NexxusConfig & {
  /** Management HTTP server config — see `NexxusManagementServer`. */
  management: {
    port: number;
    token: string;
  };
  hub?: {
    endpoint: string;
    token: string;
  }
};

export abstract class NexxusBaseWorker<
  T extends NexxusBaseWorkerConfig,
  Ev extends NexxusBaseWorkerEvents = {},
  TPayload extends NexxusBaseQueuePayload = NexxusBaseQueuePayload,
  TStats extends NexxusBaseWorkerStats = NexxusBaseWorkerStats
>
  extends NexxusBaseService<T, Ev extends NexxusBaseWorkerEvents ? Ev : NexxusBaseWorkerEvents, TStats> {

  public static logger: NexxusBaseLogger<any>;
  public static database: NexxusDatabaseAdapter<NexxusConfig, NexxusDatabaseAdapterEvents>;
  public static messageQueue: NexxusMessageQueueAdapter<NexxusConfig, NexxusMessageQueueAdapterEvents, any>;
  public static redis: NexxusRedis;

  protected static configRootKey: string = 'app';
  protected initialized: boolean = false;
  protected static loggerLabel: Readonly<string> = 'NxxWorker';
  protected static readonly loadedApps: Map<string, NexxusApplication> = new Map();
  protected abstract queueName: NexxusQueueName;
  protected abstract nodeRole: string;

  private managementServer: NexxusManagementServer | null = null;
  /**
   * Fresh uuid v4 minted at Hub registration time and held for the process
   * lifetime so `close()` can send the matching de-register. Set only when
   * the register-retry promise resolves — stays `null` while retry is
   * still attempting or when `config.hub` is absent, and the de-register
   * path is a no-op in both cases.
   */
  private nodeId: string | null = null;
  /**
   * Hub client instance held for this process lifetime. Constructed in
   * `registerWithHub()`, disposed at the start of `close()` so any
   * in-flight register retry halts, then used one more time by
   * `unregisterFromHub()` for the DELETE (which doesn't retry, so
   * dispose doesn't interfere).
   */
  protected hubClient: NexxusHubClient | null = null;

  /**
   * Adapter classes this deployment ships as static dependencies. Config
   * values matching a key here are resolved directly to the class; other
   * values are treated as npm package names and dynamic-imported by the
   * shared resolver in core-lib.
   *
   * Mirrors the same map on `NexxusApi` — API and worker processes both
   * declare `logger`/`database`/`message_queue` in their config's `app`
   * section and use the same builtin surface.
   */
  private static readonly builtinFactoryServices: Record<string, NexxusFactoryServiceClass> = {
    [WinstonNexxusLogger.name]: WinstonNexxusLogger,
  };

  private static readonly builtinConstructableServices: Record<string, NexxusConstructableServiceClass> = {
    [NexxusElasticsearchDb.name]: NexxusElasticsearchDb,
    [NexxusRabbitMq.name]:        NexxusRabbitMq,
  };

  /**
   * Resolves + registers a factory-style service (currently just the logger).
   * Config value is looked up in `builtinFactoryServices` first; a miss falls
   * through to dynamic import against the app's install tree. Registration is
   * batched — the next `configManager.validateServices()` call picks up the
   * resolved class's schema.
   */
  public static async resolveFactoryService(
    configManager: NexxusConfigManager,
    configuredName: string
  ): Promise<NexxusFactoryServiceClass> {
    const cls = await resolveFactoryServiceClass(configuredName, NexxusBaseWorker.builtinFactoryServices);

    configManager.registerService(cls);

    return cls;
  }

  /**
   * Resolves + registers a constructable service (database, message queue).
   * Same lookup-then-import shape as `resolveFactoryService`, minus the
   * `create()` requirement.
   */
  public static async resolveConstructableService(
    configManager: NexxusConfigManager,
    configuredName: string
  ): Promise<NexxusConstructableServiceClass> {
    const cls = await resolveConstructableServiceClass(configuredName, NexxusBaseWorker.builtinConstructableServices);

    configManager.registerService(cls);

    return cls;
  }

  constructor(services: NexxusWorkerServices) {
    super(services.configManager.getConfig('app') as T);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new FatalErrorException('Logger service is not an instance of NexxusBaseLogger');
    }

    if (!(services.database instanceof NexxusDatabaseAdapter)) {
      throw new FatalErrorException('Database service is not an instance of NexxusDatabaseAdapter');
    }

    if (!(services.messageQueue instanceof NexxusMessageQueueAdapter)) {
      throw new FatalErrorException('Message Queue service is not an instance of NexxusMessageQueueAdapter');
    }

    if (!(services.redis instanceof NexxusRedis)) {
      throw new FatalErrorException('Redis service is not an instance of NexxusRedis');
    }

    NexxusBaseWorker.logger = services.logger;
    NexxusBaseWorker.database = services.database;
    NexxusBaseWorker.messageQueue = services.messageQueue;
    NexxusBaseWorker.redis = services.redis;

    // Construct the Hub client eagerly so subclasses that need Hub access
    // earlier than `init()` (e.g. NexxusVolatileTransportWorker's
    // `beforeConsume()` for slot picking) can use it. No side effects at
    // construction time — the retry loop only starts on the first call to
    // registerNode / listNodesByRole.
    if (this.config.hub) {
      this.hubClient = new NexxusHubClient(this.config.hub, services.logger);
    }
  }

  public async init() : Promise<void> {
    await NexxusBaseWorker.loadApps();
    await NexxusBaseWorker.messageQueue.consumeMessages(this.queueName, this.processMessage.bind(this) as any);

    this.initialized = true;

    // Boot the management HTTP server after the worker is otherwise ready so
    // `getStats()` responses reflect a fully-initialized node. The config
    // field is guaranteed present by AJV validation at bootstrap time.
    const managementConfig = this.config.management;

    this.managementServer = new NexxusManagementServer(this, managementConfig);

    await this.managementServer.start();

    NexxusBaseWorker.logger.info(`Management server listening on port ${managementConfig.port}`, NexxusBaseWorker.loggerLabel);

    this.registerWithHub();
  }

  /**
   * Baseline close for any worker — stops the management HTTP server so its
   * port frees and Hub sees the node fall off its heartbeat window. Concrete
   * workers with additional cleanup (draining MQ consumers, terminating
   * websocket connections, etc.) should override and call `super.close()`.
   */
  public async close(): Promise<void> {
    // Halt any still-in-flight register retry. dispose() flips a flag the
    // retry loop checks at each iteration; the pending register promise
    // rejects (caught in registerWithHub). No effect if register already
    // succeeded — the retry loop was inactive.
    this.hubClient?.dispose();

    // Tell Hub we're going down before we tear anything else down, so a
    // watching operator sees the entry disappear before local ports close.
    // Uses the same client; unregisterNode doesn't retry so dispose() is fine.
    await this.unregisterFromHub();
    this.hubClient = null;

    this.managementServer?.close();
    this.managementServer = null;

    return Promise.resolve();
  }

  /**
   * Public stats surface for this worker. Returns the baseline fields
   * every worker exposes plus whatever `getOwnStats()` contributes.
   *
   * **Do not override.** Subclasses that need extra fields should
   * implement `getOwnStats()` instead — that way the base fields can't
   * be accidentally dropped by a subclass forgetting a `super` call,
   * and the shape of the public stats stays consistent across every
   * worker.
   */
  public async getStats(): Promise<TStats> {
    return {
      uptime: process.uptime(),
      queueName: this.queueName,
      loadedApps: NexxusBaseWorker.loadedApps.size,
      initialized: this.initialized,
      logger: await NexxusBaseWorker.logger.getStats(),
      ...(await this.getOwnStats()),
    } as unknown as TStats;
  }

  /**
   * Extension hook for subclasses to contribute additional stats fields
   * beyond the `NexxusBaseWorkerStats` baseline. Return type is
   * `Omit<TStats, keyof NexxusBaseWorkerStats>` so the compiler enforces
   * that the object contains exactly the fields the subclass widened
   * `TStats` with — no base field can be shadowed from here.
   *
   * Multi-level chains (transport workers) that contribute fields at
   * intermediate levels should override this AND spread
   * `super.getOwnStats()` to preserve ancestor contributions.
   *
   * Default returns an empty object — right for subclasses that don't
   * widen `TStats`.
   */
  protected async getOwnStats(): Promise<Omit<TStats, keyof NexxusBaseWorkerStats>> {
    return Promise.resolve({} as Omit<TStats, keyof NexxusBaseWorkerStats>);
  }

  /**
   * Kick off the Hub-register retry loop. No-op when `config.hub` is
   * absent — nodes without a `hub` block run standalone (local dev).
   *
   * Non-blocking: returns as soon as the loop is scheduled. The first
   * attempt fires immediately; subsequent attempts every 30s until
   * success. `close()` stops the loop via the stored handle.
   *
   * `this.nodeId` is set only on the FIRST successful attempt (from the
   * `onSuccess` callback), so `unregisterFromHub()` correctly no-ops
   * while we're still retrying or if we never register.
   */
  private registerWithHub(): void {
    if (!this.hubClient) {
      return;
    }

    const pendingNodeId = randomUUID();

    // Fire-and-forget: the client retries internally until Hub is reachable
    // (logging each failed attempt at `warn` from inside `retryUntilSuccess`),
    // so we don't need our own onError callback here. On first success the
    // promise resolves once — we capture the id then. A rejection reaches us
    // only if `dispose()` interrupts the retry loop during shutdown; log at
    // debug and move on.
    void this.hubClient.registerNode(() => this.buildHubPayload(pendingNodeId))
      .then((payload) => {
        this.nodeId = payload.id;
        NexxusBaseWorker.logger.info(
          `Registered with Hub as ${payload.id}`,
          NexxusBaseWorker.loggerLabel
        );
      }).catch((err: Error) => {
        NexxusBaseWorker.logger.warn(
          `Hub registration abandoned: ${err.message}`,
          NexxusBaseWorker.loggerLabel
        );
      });
  }

  /**
   * Assemble the payload sent to Hub. Called both on initial register and
   * on each periodic re-register (so `stats` reflects live state).
   *
   * Subclasses with worker-shape-specific fields (currently only
   * `NexxusVolatileTransportWorker`, which adds `slot`) override this and
   * merge their extras onto `await super.buildHubPayload(...)`. Base
   * workers with no extras don't touch it.
   */
  protected async buildHubPayload(pendingNodeId: string): Promise<NexxusHubNode> {
    return {
      id: pendingNodeId,
      role: this.nodeRole,
      privateIpAddress: NexxusHubClient.discoverPrivateIpAddress(),
      managementPort: this.config.management.port,
      dependencies: NexxusHubClient.readNexxusDependencies(),
      stats: await this.getStats(),
    };
  }

  /**
   * Counterpart to `registerWithHub`. No-op when we never got a `nodeId`
   * (Hub absent or register failed). Any failure here is logged and
   * swallowed — worst case is a leaked entry that clears on the next Hub
   * restart, which the design deliberately accepts.
   */
  private async unregisterFromHub(): Promise<void> {
    if (this.nodeId === null || !this.hubClient) {
      return;
    }

    try {
      await this.hubClient.unregisterNode(this.nodeId);
      NexxusBaseWorker.logger.info('Unregistered from Hub', NexxusBaseWorker.loggerLabel);
    } catch (err) {
      NexxusBaseWorker.logger.warn(
        `Failed to unregister from Hub — leaving entry to leak: ${(err as Error).message}`,
        NexxusBaseWorker.loggerLabel
      );
    } finally {
      this.nodeId = null;
    }
  }

  protected async publish<Q extends NexxusQueueName>(
    queueName: Q,
    message: NexxusQueuePayload<Q>,
    metadata?: Record<string, any>
  ): Promise<void> {
    return await NexxusBaseWorker.messageQueue.publishMessage(queueName, message, metadata);
  }

  protected abstract processMessage(payload: NexxusQueueMessage<TPayload>) : Promise<void>;

  protected static async loadApps(): Promise<void> {
    const results = await NexxusBaseWorker.database.searchItems({ type: MODEL_REGISTRY.application });

    for (let app of results) {
      NexxusBaseWorker.loadedApps.set(app.getData().id as string, app);
    }

    NexxusBaseWorker.logger.info(`Loaded ${NexxusBaseWorker.loadedApps.size} applications into Worker service`, NexxusBaseWorker.loggerLabel);
  }
}
