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

import { NexxusMessageCompressor, NexxusCompressionConfig } from './Compression';

/**
 * Shared shape every MQ adapter's config extends. Currently just adds the
 * optional `compression` block; future MQ-generic fields (message TTL,
 * retry policy, etc.) belong here too so every concrete adapter picks
 * them up.
 */
export type NexxusMessageQueueConfig = NexxusConfig & {
  compression?: NexxusCompressionConfig;
};

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
  T extends NexxusMessageQueueConfig,
  Ev extends NexxusMessageQueueAdapterEvents,
  TStats extends NexxusMessageQueueAdapterStats
>
  extends NexxusBaseService<T, Ev extends NexxusMessageQueueAdapterEvents ? Ev : NexxusMessageQueueAdapterEvents, TStats> {

  protected static configRootKey: string = 'message_queue';
  protected static loggerLabel: Readonly<string> = 'NxxMessageQueue';
  protected abstract reconnectDelayMs: number;

  public static logger: NexxusBaseLogger<any>;

  /**
   * Compressor used by `serializePayload` / `deserializePayload`. Non-null
   * only when `config.compression.enabled === true`. Deployment-wide
   * policy: every node must have the same setting, otherwise producers
   * and consumers will talk past each other.
   *
   * Definite-assignment `!` — assigned unconditionally in the constructor
   * (to either an instance or `null`), TS just can't see through the
   * ternary from the property declaration site.
   */
  protected readonly compressor!: NexxusMessageCompressor | null;

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

  /**
   * True when consumption is externally paused via `pauseConsuming()`.
   * Guards the auto-restore path in `tryOnce()` (won't re-consume on
   * reconnect while paused). Cleared by `resumeConsuming()`.
   */
  protected consumingPaused: boolean = false;

  /**
   * (queueName → callback) tuples for every active `consumeMessages`
   * call. Retained across MQ reconnects so the state machine restores
   * each consumer via `doConsume(queue, cb)` after `doConnect`
   * succeeds. The callback type is erased to `any` here because
   * TypeScript Maps can't hold heterogeneous parameterized callbacks;
   * the public `consumeMessages` signature preserves the Q-generic for
   * callers, and the erasure is invisible outside this class.
   */
  protected consumers: Map<NexxusQueueName, (message: NexxusQueueMessage<any>) => Promise<void>> = new Map();

  constructor(services: INexxusBaseServices) {
    super(services.configManager.getConfig('message_queue') as T);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new Error(`Logger service is not an instance of NexxusBaseLogger`);
    }

    NexxusMessageQueueAdapter.logger = services.logger;

    this.compressor = this.config.compression?.enabled
      ? new NexxusMessageCompressor(this.config.compression)
      : null;

    if (this.compressor) {
      NexxusMessageQueueAdapter.logger.info(
        `MQ compression enabled: algo=${this.config.compression!.algo}`,
        NexxusMessageQueueAdapter.loggerLabel,
      );
    }
  }

  /**
   * Encode a typed payload for the wire. JSON → Buffer, then compress if
   * enabled. Concrete adapters call this in their `publishMessage` in
   * place of the raw `Buffer.from(JSON.stringify(...))` so compression
   * policy stays in one place.
   */
  protected serializePayload<Q extends NexxusQueueName>(
    payload: NexxusQueuePayload<Q>,
  ): Promise<Buffer> {
    const jsonBuf = Buffer.from(JSON.stringify(payload));

    if (!this.compressor) {
      return Promise.resolve(jsonBuf);
    }

    return this.compressor.compress(jsonBuf);
  }

  /**
   * Decode a wire buffer back to the typed payload. Decompress if enabled,
   * then JSON.parse. Concrete adapters call this in their consume loop
   * in place of the raw `JSON.parse(buf.toString())`.
   *
   * Whether the buffer is actually compressed is a deployment-wide
   * property, not per-message — this method trusts `this.compressor`
   * being non-null to mean "everything on the wire is compressed."
   */
  protected async deserializePayload<Q extends NexxusQueueName>(
    buf: Buffer,
  ): Promise<NexxusQueuePayload<Q>> {
    const jsonBuf = this.compressor ? await this.compressor.decompress(buf) : buf;

    return JSON.parse(jsonBuf.toString()) as NexxusQueuePayload<Q>;
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

  /**
   * Register a callback to consume messages from `queueName`. The
   * (queue, callback) tuple is retained on the base so MQ reconnects
   * and external `resumeConsuming()` calls can restore the consumer
   * without the caller re-registering.
   *
   * If already connected and not paused, dispatches immediately to
   * `doConsume`. Otherwise the tuple is stashed and picked up by the
   * next reconnect / resume transition.
   */
  public async consumeMessages<Q extends NexxusQueueName>(
    queueName: Q,
    onMessage: (message: NexxusQueueMessage<NexxusQueuePayload<Q>>) => Promise<void>
  ): Promise<void> {
    const erased = onMessage as (message: NexxusQueueMessage<any>) => Promise<void>;

    this.consumers.set(queueName, erased);

    if (this.connected && !this.consumingPaused) {
      await this.doConsume(queueName, erased);
    }
  }

  /**
   * Pause all consumption. Idempotent — second+ call is a no-op. If
   * currently connected, delegates to `doCancelAll` so the concrete
   * can cancel its consumer tags with the broker. If disconnected,
   * only the flag is set — the next reconnect's auto-restore consults
   * the flag and skips.
   */
  public async pauseConsuming(): Promise<void> {
    if (this.consumingPaused) {
      return;
    }

    this.consumingPaused = true;

    if (this.connected) {
      await this.doCancelAll();
    }
  }

  /**
   * Resume consumption. Idempotent — second+ call is a no-op. If
   * currently connected, iterates the stored consumers and re-registers
   * each via `doConsume`. If disconnected, only the flag is cleared —
   * the next reconnect's auto-restore now sees `!consumingPaused` and
   * does the actual work.
   */
  public async resumeConsuming(): Promise<void> {
    if (!this.consumingPaused) {
      return;
    }

    this.consumingPaused = false;

    if (this.connected) {
      for (const [queue, cb] of this.consumers) {
        await this.doConsume(queue, cb);
      }
    }
  }

  /**
   * Concrete's entry point for actually opening a consumer against the
   * live connection. Called from the base's `consumeMessages` (initial
   * registration), `resumeConsuming` (external override), and
   * `tryOnce`'s auto-restore branch (MQ reconnect). The concrete tracks
   * broker-specific state — e.g. RabbitMQ's per-consumer tag — locally
   * so it can cancel later via `doCancelAll`.
   */
  protected abstract doConsume(
    queueName: NexxusQueueName,
    onMessage: (message: NexxusQueueMessage<any>) => Promise<void>
  ): Promise<void>;

  /**
   * Cancel every active consumer on the live connection. Called from
   * `pauseConsuming` when connected. Idempotent-friendly — safe even
   * if the concrete's channel is already null (e.g. connection just
   * dropped mid-pause). Errors on individual cancellations should be
   * logged and swallowed; failing to cancel doesn't block shutdown.
   */
  protected abstract doCancelAll(): Promise<void>;

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

      // Restore any previously-registered consumers unless externally
      // paused. Callers of consumeMessages don't have to re-register on
      // MQ reconnect — the (queue, cb) map is retained across drop →
      // reconnect cycles. When paused, this is skipped; the worker's
      // resumeConsuming() call is the sole restore path in that case.
      if (!this.consumingPaused && this.consumers.size > 0) {
        for (const [queue, cb] of this.consumers) {
          try {
            await this.doConsume(queue, cb);
          } catch (restoreErr) {
            NexxusMessageQueueAdapter.logger.warn(
              `Failed to restore consumer for queue "${queue}": ${(restoreErr as Error).message}`,
              NexxusMessageQueueAdapter.loggerLabel,
            );
          }
        }
      }

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
