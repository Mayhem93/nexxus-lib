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
  NexxusAclManager,
  NexxusAclRole,
  DEFAULT_ACL_ROLE,
  DEFAULT_ACL_ROLE_ID,
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
   * Per-service connection state. Kept up-to-date by the `'connect'`/
   * `'disconnect'` listeners wired in the constructor. `isAvailable`
   * derives from the AND across all three; the MQ pause/resume gate
   * (follow-up) will read the same signal to stop pulling messages
   * we can't fully process.
   */
  private serviceState: { db: boolean; mq: boolean; redis: boolean } = {
    db: false,
    mq: false,
    redis: false,
  };

  /**
   * Callers awaiting the first "all services connected" transition.
   * Resolved and cleared the moment `isAvailable` flips true. `init()`
   * uses this to block until every upstream is up before starting
   * message consumption.
   */
  private allConnectedResolvers: Array<() => void> = [];

  /**
   * True from `close()` onwards. Suppresses the "service disconnected"
   * warn in `markServiceDown` during expected teardown — SIGINT walks
   * through db.disconnect / mq.disconnect / redis.close which each fire
   * a `'disconnect'` event, and without this the log falsely implies
   * the worker is failing when it's shutting down cleanly.
   */
  private closing: boolean = false;

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

    // Wire connect/disconnect listeners BEFORE anything calls the services'
    // connect() — so no first-connect event gets fired-and-missed. From here
    // on, `this.serviceState` mirrors the upstream reality; the init() gate
    // and (follow-up task) the MQ pause/resume both read it.
    services.database.on('connect',    () => this.markServiceUp('db'));
    services.database.on('disconnect', () => this.markServiceDown('db'));
    services.messageQueue.on('connect',    () => this.markServiceUp('mq'));
    services.messageQueue.on('disconnect', () => this.markServiceDown('mq'));
    services.redis.on('connect',    () => this.markServiceUp('redis'));
    services.redis.on('disconnect', () => this.markServiceDown('redis'));

    // Construct the Hub client eagerly so subclasses that need Hub access
    // earlier than `init()` (e.g. NexxusVolatileTransportWorker's
    // `beforeConsume()` for slot picking) can use it. No side effects at
    // construction time — the retry loop only starts on the first call to
    // registerNode / listNodesByRole.
    if (this.config.hub) {
      this.hubClient = new NexxusHubClient(this.config.hub, services.logger);
    }
  }

  /**
   * `true` when all upstream services (DB, MQ, Redis) are currently
   * reporting connected. The follow-up MQ pause/resume gate will read
   * this to stop consumption while any dep is down.
   */
  public get isAvailable(): boolean {
    return this.serviceState.db && this.serviceState.mq && this.serviceState.redis;
  }

  private markServiceUp(name: 'db' | 'mq' | 'redis'): void {
    if (this.serviceState[name]) {
      return;
    }

    this.serviceState[name] = true;
    NexxusBaseWorker.logger.info(`Upstream service "${name}" connected`, NexxusBaseWorker.loggerLabel);

    if (this.isAvailable) {
      const resolvers = this.allConnectedResolvers;

      this.allConnectedResolvers = [];

      for (const resolve of resolvers) resolve();

      // Resume MQ consumption after any prior pauseConsuming. Idempotent
      // if we were never paused, so the initial connect wave flows
      // through here safely as a no-op.
      void NexxusBaseWorker.messageQueue.resumeConsuming().catch((err: Error) => {
        NexxusBaseWorker.logger.warn(
          `resumeConsuming failed: ${err.message}`,
          NexxusBaseWorker.loggerLabel,
        );
      });
    }
  }

  private markServiceDown(name: 'db' | 'mq' | 'redis'): void {
    if (!this.serviceState[name]) {
      return;
    }

    const wasAvailable = this.isAvailable;

    this.serviceState[name] = false;

    if (!this.closing) {
      NexxusBaseWorker.logger.warn(
        `Upstream service "${name}" disconnected — worker will pause consuming until it reconnects`,
        NexxusBaseWorker.loggerLabel,
      );
    }

    // Pause on the availability→unavailability edge only. Second+
    // disconnect (e.g. MQ drops after DB already dropped) finds
    // wasAvailable=false and skips — pause is already in effect.
    if (wasAvailable && !this.closing) {
      void NexxusBaseWorker.messageQueue.pauseConsuming().catch((err: Error) => {
        NexxusBaseWorker.logger.warn(
          `pauseConsuming failed: ${err.message}`,
          NexxusBaseWorker.loggerLabel,
        );
      });
    }
  }

  /**
   * Returns once every upstream service has emitted `'connect'`. Resolves
   * immediately if we're already fully connected. No timeout — callers who
   * want one should wrap this in `Promise.race`.
   */
  private waitUntilAllConnected(): Promise<void> {
    if (this.isAvailable) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.allConnectedResolvers.push(resolve);
    });
  }

  public async init() : Promise<void> {
    NexxusBaseWorker.logger.info('Initializing worker service...', NexxusBaseWorker.loggerLabel);

    // Fire off every upstream service's connect() in parallel. The listeners
    // wired in the constructor pick up each `'connect'` event and update
    // state; `waitUntilAllConnected()` returns once all three are up. Only
    // after every dep is up do we call consumeMessages — otherwise the
    // consumer callback could fire against a not-yet-connected DB/Redis.
    const connectPromises = [
      NexxusBaseWorker.database.connect(),
      NexxusBaseWorker.messageQueue.connect(),
      NexxusBaseWorker.redis.init(),
    ];

    await Promise.all([Promise.all(connectPromises), this.waitUntilAllConnected()]);

    NexxusBaseWorker.logger.info('All upstream services connected', NexxusBaseWorker.loggerLabel);

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
    this.closing = true;
    NexxusBaseWorker.logger.info('Closing worker service...', NexxusBaseWorker.loggerLabel);

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

    // Upstream service shutdown happens after Hub deregistration + local
    // ports go away, so any in-flight `processMessage` has had a chance
    // to finish (concrete workers that need graceful message drain
    // should override this method, drain, then call `super.close()`).
    // `allSettled` so one broker's sticky close doesn't block the
    // others.
    const results = await Promise.allSettled([
      NexxusBaseWorker.database.disconnect(),
      NexxusBaseWorker.messageQueue.disconnect(),
      NexxusBaseWorker.redis.close(),
    ]);

    for (const [i, r] of results.entries()) {
      if (r.status === 'rejected') {
        const name = ['database', 'messageQueue', 'redis'][i];

        NexxusBaseWorker.logger.warn(
          `Upstream service "${name}" failed to close cleanly: ${(r.reason as Error)?.message ?? r.reason}`,
          NexxusBaseWorker.loggerLabel,
        );
      }
    }

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
  protected getOwnStats(): Promise<Omit<TStats, keyof NexxusBaseWorkerStats>> {
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

    await NexxusBaseWorker.loadAclRoles();
  }

  /**
   * Load each ACL-enabled app's roles from its `acl` index and attach one
   * `NexxusAclManager` per role to the app (keyed by role name). The framework
   * default role is always created in-memory; a persisted role reusing the
   * default id is ignored (the default is not overridable). Finally, validate
   * that every `userTypes[*].roles` reference resolves to a loaded role.
   *
   * Runs one query per ACL-enabled app, in parallel.
   */
  protected static async loadAclRoles(): Promise<void> {
    const aclApps = [...NexxusBaseWorker.loadedApps.values()].filter(app => app.isAclEnabled());

    await Promise.all(aclApps.map(async app => {
      const appId = app.getData().id as string;
      const dbRoles = await NexxusBaseWorker.database.searchItems({ appId, type: MODEL_REGISTRY.acl });

      const defaultRole = new NexxusAclRole({ ...DEFAULT_ACL_ROLE, appId });

      defaultRole.validateAgainstSchema(app);

      const managers: NexxusAclManager[] = [ new NexxusAclManager(defaultRole) ];

      for (const role of dbRoles) {
        if (role.getName() === DEFAULT_ACL_ROLE_ID) {
          NexxusBaseWorker.logger.warn(
            `Ignoring role "${DEFAULT_ACL_ROLE_ID}" persisted for app "${appId}" — the default role cannot be overridden`,
            NexxusBaseWorker.loggerLabel,
          );

          continue;
        }

        role.validateAgainstSchema(app);
        managers.push(new NexxusAclManager(role));
      }

      app.setRoleManagers(managers);

      // Fail fast on dangling role references so a typo surfaces at boot.
      const userTypes = app.getUserTypes() ?? {};

      for (const [userType, cfg] of Object.entries(userTypes)) {
        for (const roleName of cfg.roles ?? []) {
          if (!app.getRoleManager(roleName)) {
            throw new FatalErrorException(
              `Application "${appId}" user type "${userType}" references unknown ACL role "${roleName}"`
            );
          }
        }
      }

      NexxusBaseWorker.logger.info(
        `Loaded ${managers.length} ACL role(s) for app "${appId}"`,
        NexxusBaseWorker.loggerLabel,
      );
    }));
  }
}
