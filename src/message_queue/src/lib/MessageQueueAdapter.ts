import {
  NexxusConfig,
  NexxusBaseService,
  INexxusBaseServices,
  NexxusBaseLogger,
  NexxusQueueName,
  NexxusQueuePayload,
  NexxusBaseQueuePayload,
  FatalErrorException,
} from '@mayhem93/nexxus-core-lib';

export type NexxusMessageQueueAdapterEvents = {
  connect: [];
  disconnect: [];
  error: [Error];
  message: [any];
}

export interface NexxusQueueMessage<TPayload = NexxusBaseQueuePayload> {
  payload: TPayload;
  metadata?: Record<string, any>;
}

export type NexxusMessageQueueAdapterStats = {
  id: string | 'unknown';
};

export abstract class NexxusMessageQueueAdapter<
  T extends NexxusConfig,
  Ev extends NexxusMessageQueueAdapterEvents,
  TStats extends NexxusMessageQueueAdapterStats
>
  extends NexxusBaseService<T, Ev extends NexxusMessageQueueAdapterEvents ? Ev : NexxusMessageQueueAdapterEvents, TStats> {

  protected static configRootKey: string = 'message_queue';
  protected static loggerLabel: Readonly<string> = 'NxxMessageQueue';
  protected abstract reconnectDelayMs: number;

  public static logger: NexxusBaseLogger<any>;

  /** Retry timer for the reconnection loop. Null when we're not actively trying. */
  private retryTimer: NodeJS.Timeout | null = null;
  /** Callers awaiting `connect()` — resolved on first successful (re)connection. */
  private connectResolvers: Array<() => void> = [];
  /** Rejecters paired with `connectResolvers`, fired on fatal auth failure or `disconnect()`. */
  private connectRejecters: Array<(err: Error) => void> = [];
  /**
   * True from `connect()` until `disconnect()`. Gate for the retry loop so a
   * close event during shutdown doesn't restart reconnection, and so an
   * in-flight `tryOnce()` bails cleanly if disconnect happens mid-handshake.
   */
  private wantConnected: boolean = false;
  /** True while an underlying connection is live. Set on successful `doConnect`, cleared on `onConnectionLost`/`disconnect`. */
  private connected: boolean = false;
  /** Reentrance guard for `tryOnce` — prevents overlap if `doConnect` hangs longer than `reconnectDelayMs`. */
  private tryInFlight: boolean = false;

  constructor(services: INexxusBaseServices) {
    super(services.configManager.getConfig('message_queue') as T);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new Error(`Logger service is not an instance of NexxusBaseLogger`);
    }

    NexxusMessageQueueAdapter.logger = services.logger;
  }

  /**
   * Public entry point. Returns a promise that resolves on the FIRST
   * successful connection — subsequent (re)connections are surfaced via the
   * `'connect'` event. Non-throwing on retryable errors: they just re-arm
   * the retry timer. Rejects only on fatal errors classified by
   * `isFatalConnectError()`.
   */
  public connect(): Promise<void> {
    this.wantConnected = true;

    if (this.connected) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.connectResolvers.push(resolve);
      this.connectRejecters.push(reject);
      this.startRetryLoop();
    });
  }

  /**
   * Cleanly shut down. Flips `wantConnected` false (so the retry loop
   * doesn't restart on the resulting close event), rejects any callers
   * still awaiting the initial connect, and tears down the underlying
   * connection via `doDisconnect()`.
   */
  public async disconnect(): Promise<void> {
    this.wantConnected = false;
    this.stopRetryLoop();

    const rejecters = this.connectRejecters;

    this.connectResolvers = [];
    this.connectRejecters = [];

    for (const rej of rejecters) {
      rej(new Error('MQ adapter disconnected before connection could be established'));
    }

    if (this.connected) {
      await this.doDisconnect();
      this.connected = false;
    }
  }

  /**
   * Called BY THE CONCRETE ADAPTER from its underlying-client close handler
   * when the live connection dies unexpectedly. The base emits
   * `'disconnect'` and (if `wantConnected`) restarts the retry loop.
   *
   * Do NOT call this from `doDisconnect()` — that's the graceful path and
   * `disconnect()` already owns the state transitions there.
   */
  protected onConnectionLost(): void {
    this.connected = false;

    NexxusMessageQueueAdapter.logger.info('MQ connection closed', NexxusMessageQueueAdapter.loggerLabel);

    this.emit('disconnect');

    if (this.wantConnected) {
      this.startRetryLoop();
    }
  }

  // ---- Contract for the concrete adapter ----

  /**
   * Open the underlying connection. Throw on failure. Wire the client's
   * close/disconnect event to call `this.onConnectionLost()` so the base's
   * retry loop can restart on unexpected disconnects.
   */
  protected abstract doConnect(): Promise<void>;

  /**
   * Cleanly close the underlying connection. Called by the base from
   * `disconnect()` (graceful shutdown) and from the race-handling branch of
   * `tryOnce()` (disconnect flipped during handshake). Idempotent-friendly:
   * safe if called with no live connection.
   */
  protected abstract doDisconnect(): Promise<void>;

  /**
   * Classify a `doConnect()` error as fatal (give up, reject the
   * `connect()` promise) or retryable (log and let the timer re-fire).
   * Match narrowly — errors we don't recognize should default to retryable,
   * because retrying a truly-fatal error costs log noise but stopping on a
   * transient one strands the adapter forever.
   */
  protected abstract isFatalConnectError(err: unknown): boolean;

  /**
   * Returns a bootstrapper wired with the given caller-supplied options.
   * Called by the Nexxus CLI at deployment provisioning time (options from
   * CLI vars) and by the Hub API on re-provisioning (options from the HTTP
   * request body). See `NexxusMessageQueueBootstrapper` for the full
   * contract.
   */
  abstract getBootstrapper(options: Record<string, any>): NexxusMessageQueueBootstrapper;

  abstract publishMessage<Q extends NexxusQueueName>(
    queueName: Q,
    message: NexxusQueuePayload<Q>,
    metadata?: Record<string, any>
  ): Promise<void>;

  abstract consumeMessages<Q extends NexxusQueueName>(
    queueName: Q,
    onMessage: (message: NexxusQueueMessage<NexxusQueuePayload<Q>>) => Promise<void>
  ) : Promise<void>;

  /**
   * Check whether a queue by this name currently exists on the broker.
   * Returns `true` even for queues we don't own (e.g. exclusive queues
   * owned by another connection are "existing" from our perspective — we
   * just can't use them).
   *
   * Called from the volatile-transport worker as a friendly pre-check
   * before `createVolatileQueue`: rather than surfacing a broker-native
   * error like RabbitMQ's `RESOURCE_LOCKED`, the worker sees a plain
   * `true` and throws a domain-shaped "slot already taken" error.
   */
  abstract queueExists(name: string): Promise<boolean>;

  /**
   * Declare a per-slot volatile queue on the broker. Called from the
   * volatile-transport worker on startup once it's picked its slot via
   * the Hub. Broker-specific meaning of "volatile":
   *   - RabbitMQ: non-durable + auto-delete + exclusive (broker cleans on
   *     connection close; a second attempt to declare from another
   *     connection fails, giving us broker-level collision protection).
   *   - Kafka / NATS / others (future): whatever "ephemeral topic" primitive fits,
   *     with explicit deletion required in `deleteQueue`.
   */
  abstract createVolatileQueue(name: string): Promise<void>;

  /**
   * Delete a queue by name. Called from the volatile-transport worker's
   * graceful-shutdown path after draining. For RabbitMQ this is often a
   * no-op (auto-delete already fired) but calling it is safe and
   * explicit; for brokers without auto-delete semantics it's mandatory.
   */
  abstract deleteQueue(name: string): Promise<void>;

  // ---- State-machine internals ----

  private startRetryLoop(): void {
    if (this.retryTimer) {
      return;
    }

    void this.tryOnce();
    this.retryTimer = setInterval(() => { void this.tryOnce(); }, this.reconnectDelayMs);
  }

  private stopRetryLoop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async tryOnce(): Promise<void> {
    if (!this.wantConnected) {
      this.stopRetryLoop();

      return;
    }

    if (this.tryInFlight) {
      return;
    }

    this.tryInFlight = true;

    try {
      await this.doConnect();

      // Race: disconnect() flipped wantConnected while we were mid-handshake.
      // Tear down what the concrete just opened; don't publish it as live.
      if (!this.wantConnected) {
        try { await this.doDisconnect(); } catch { /* best-effort */ }

        return;
      }

      this.connected = true;
      this.stopRetryLoop();

      NexxusMessageQueueAdapter.logger.info('Connected to MQ broker', NexxusMessageQueueAdapter.loggerLabel);
      this.emit('connect');

      const resolvers = this.connectResolvers;

      this.connectResolvers = [];
      this.connectRejecters = [];

      for (const resolver of resolvers) {
        resolver();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (this.isFatalConnectError(err)) {
        NexxusMessageQueueAdapter.logger.error(`MQ connect failed (fatal, not retrying): ${msg}`, NexxusMessageQueueAdapter.loggerLabel);
        this.wantConnected = false;
        this.stopRetryLoop();

        const wrapped = new FatalErrorException(`MQ connect fatal: ${msg}`);

        this.emit('error', wrapped);

        const rejecters = this.connectRejecters;

        this.connectResolvers = [];
        this.connectRejecters = [];

        for (const rej of rejecters) rej(wrapped);

        return;
      }

      NexxusMessageQueueAdapter.logger.warn(
        `MQ connect failed, retrying in ${this.reconnectDelayMs}ms: ${msg}`,
        NexxusMessageQueueAdapter.loggerLabel
      );
    } finally {
      this.tryInFlight = false;
    }
  }
}

/**
 * Deployment-time hook surface for a message-queue adapter. Each concrete
 * adapter ships its own subclass with the connected client/channel passed in
 * at construction; callers (Nexxus CLI at provisioning time, Hub API on
 * re-provisioning) obtain an instance via the adapter's `getBootstrapper()`
 * method so they never touch the underlying broker driver directly.
 *
 * **Migration is explicitly out of scope for this class** — same posture as
 * `NexxusDatabaseBootstrapper`. Renaming stages, redeclaring queues with
 * different types, or rebuilding topology after a breaking change belongs to
 * a separate migration surface (not yet designed).
 */
export abstract class NexxusMessageQueueBootstrapper<TOptions = Record<string, any>> {
  constructor(protected readonly options: TOptions) {}

  /**
   * Idempotent one-shot deployment setup for the message-queue broker.
   * Declares the deployment-wide topology — cross-node broadcast surface
   * (e.g. a fanout exchange for system messages) plus one queue per static
   * pipeline stage. Dynamic-pattern stages (per-slot queues named
   * `<stage>_<N>`) are skipped: those are declared by the workers
   * themselves once they've picked a slot.
   *
   * **Must be idempotent.** Safe to re-run: broker-native "declare if
   * missing" primitives (e.g. `assertExchange` / `assertQueue`) already
   * give us this for free. Operators running `nexxus bootstrap` twice, or
   * Hub replaying a partial setup after a restart, must be a no-op the
   * second time.
   */
  public abstract bootstrapDeployment(pipeline: string[]): Promise<void>;
}
