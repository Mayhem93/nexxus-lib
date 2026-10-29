import {
  NexxusConfig,
  NexxusBaseService,
  INexxusBaseServices,
  NexxusBaseLogger,
  NexxusQueueName,
  NexxusQueuePayload,
  NexxusBaseQueuePayload,
  FatalErrorException,
  NexxusException,
} from '@mayhem93/nexxus-core-lib';

import { NexxusMessageCompressor, NexxusCompressionConfig } from './Compression';
import { NexxusMessageQueuePublishException } from './Exceptions';

/**
 * Shared shape every MQ adapter's config extends: the fields the base itself
 * reads. Future MQ-generic fields (message TTL, retry policy, etc.) belong
 * here too so every concrete adapter picks them up.
 */
export type NexxusMessageQueueConfig = NexxusConfig & {
  compression?: NexxusCompressionConfig;
  /** Seconds to wait for the broker to confirm a publish. Default 5. */
  publishTimeout?: number;
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

/**
 * What a consumer tells the adapter about the services its handler depends on.
 * A message that fails while one of them is down is retried once it is back,
 * and that failure doesn't count against the message's retries.
 */
export type NexxusConsumeOptions = {
  /** Whether every service the handler depends on is up right now. */
  isReady: () => boolean;
  /** Resolves once they all are. */
  waitUntilReady: () => Promise<void>;
};

/**
 * One message as the broker delivered it, and the ways to settle it. The
 * concrete adapter builds one per delivery; the base decides how it's settled.
 */
export type NexxusMessageDelivery = {
  content: Buffer;
  metadata: Record<string, any>;
  /** Processed: the broker removes it. */
  ack: () => void;
  /**
   * Given up on: the broker dead-letters it, or drops it from a queue with
   * nowhere to dead-letter to.
   */
  deadLetter: () => void;
  /** Not processed: the broker returns it to the queue, for any consumer. */
  requeue: () => void;
  /**
   * False once the connection the message arrived on is gone. The broker has
   * taken the message back by then, so it must not be settled.
   */
  isLive: () => boolean;
};

type NexxusDeliveryOutcome = 'ack' | 'deadLetter' | 'requeue';

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
   * (queueName → deliver) for every active `consumeMessages` call. `deliver`
   * wraps the caller's handler with the retry / dead-letter policy, and is
   * what the concrete consumer hands each message to. Retained across MQ
   * reconnects so the state machine restores each consumer via
   * `doConsume(queue, deliver)` after `doConnect` succeeds.
   */
  protected consumers: Map<NexxusQueueName, (delivery: NexxusMessageDelivery) => void> = new Map();

  /**
   * How long to wait before each retry of a failed message — one entry per
   * retry. A message still failing after the last one is dead-lettered.
   */
  protected retryDelaysMs: ReadonlyArray<number> = [1000, 2000, 4000];

  /** How long `publishMessage` waits for the broker's confirmation when `publishTimeout` isn't set. */
  private static readonly DEFAULT_PUBLISH_TIMEOUT_SECONDS = 5;

  /** True from `stopConsuming()` on: retries end, and deliveries are handed back. */
  private stopping: boolean = false;
  /** Waits `stopConsuming()` cuts short — retry delays and readiness waits. */
  private stopWaiters: Set<() => void> = new Set();
  /** Deliveries not settled yet, so `stopConsuming()` can wait for them. */
  private inFlight: Set<Promise<void>> = new Set();

  /** For consumers that pass no options: nothing to wait for, so every failure counts. */
  private static readonly ALWAYS_READY: NexxusConsumeOptions = {
    isReady: () => true,
    waitUntilReady: () => Promise.resolve()
  };

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
   * enabled. `publishMessage` calls it before handing the bytes to
   * `doPublish`, so compression policy stays in one place.
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

  /**
   * Publish `message` to `queueName`. Resolves once the broker confirms it has
   * the message; rejects with a `NexxusMessageQueuePublishException` when there
   * is no connection, the broker refuses it, the connection goes first, or no
   * confirmation arrives within `publishTimeout` seconds.
   */
  public async publishMessage<Q extends NexxusQueueName>(
    queueName: Q,
    message: NexxusQueuePayload<Q>,
    metadata?: Record<string, any>
  ): Promise<void> {
    const content = await this.serializePayload(message);
    const timeoutSeconds = this.config.publishTimeout ?? NexxusMessageQueueAdapter.DEFAULT_PUBLISH_TIMEOUT_SECONDS;
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        this.doPublish(queueName, content, metadata),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`not confirmed within ${timeoutSeconds} s`)), timeoutSeconds * 1000);
        })
      ]);
    } catch (e) {
      throw new NexxusMessageQueuePublishException(
        `Publishing "${(message as NexxusBaseQueuePayload).event}" to "${queueName}" failed: ${(e as Error).message}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Hand an encoded message to the broker for `queueName`. Resolve once the
   * broker confirms it has it; reject when the broker refuses it or the
   * connection goes before it confirms, and at once when there's no connection
   * to publish on. The base applies the timeout.
   */
  protected abstract doPublish(queueName: NexxusQueueName, content: Buffer, metadata?: Record<string, any>): Promise<void>;

  /**
   * Register a callback to consume messages from `queueName`. The
   * (queue, callback) tuple is retained on the base so MQ reconnects
   * and external `resumeConsuming()` calls can restore the consumer
   * without the caller re-registering.
   *
   * A message is acked once `onMessage` resolves. When it rejects, the
   * message is retried and eventually dead-lettered — see `processDelivery`.
   * `options` lets a failure during an outage wait for the outage to end
   * instead of using up the message's retries.
   *
   * If already connected and not paused, dispatches immediately to
   * `doConsume`. Otherwise the tuple is stashed and picked up by the
   * next reconnect / resume transition.
   */
  public async consumeMessages<Q extends NexxusQueueName>(
    queueName: Q,
    onMessage: (message: NexxusQueueMessage<NexxusQueuePayload<Q>>) => Promise<void>,
    options: NexxusConsumeOptions = NexxusMessageQueueAdapter.ALWAYS_READY
  ): Promise<void> {
    // Erased to `any`: the map holds every queue's handler, and the public
    // signature above is what keeps each caller's payload type.
    const handler = onMessage as (message: NexxusQueueMessage<any>) => Promise<void>;
    const deliver = (delivery: NexxusMessageDelivery): void => {
      const settled = this.handleDelivery(queueName, handler, options, delivery);

      this.inFlight.add(settled);
      void settled.then(() => { this.inFlight.delete(settled); });
    };

    this.consumers.set(queueName, deliver);

    if (this.connected && !this.consumingPaused) {
      await this.doConsume(queueName, deliver);
    }
  }

  /**
   * Stop consuming for good, ahead of shutdown. Every consumer is cancelled,
   * messages waiting to be retried are handed back to their queue, and messages
   * being processed get up to `timeoutMs` to finish. Whatever is still running
   * after that is redelivered by the broker once the connection closes.
   *
   * Call it before closing the services the handlers depend on, so in-flight
   * messages don't fail halfway. Safe to call more than once.
   */
  public async stopConsuming(timeoutMs: number = 10_000): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      // Keeps consumers from coming back on a reconnect or a resume.
      this.consumingPaused = true;

      for (const wake of this.stopWaiters) {
        wake();
      }

      this.stopWaiters.clear();

      if (this.connected) {
        await this.doCancelAll();
      }
    }

    if (this.inFlight.size === 0) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;

    await Promise.race([
      Promise.all(this.inFlight),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);

    clearTimeout(timer);
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
   * does the actual work. A no-op after `stopConsuming()`.
   */
  public async resumeConsuming(): Promise<void> {
    if (!this.consumingPaused || this.stopping) {
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
   *
   * Each message goes to `deliver` as a `NexxusMessageDelivery`: the raw
   * content, and how to ack, dead-letter and requeue it on this broker. The
   * base decodes, processes and settles it — the concrete never acks itself.
   */
  protected abstract doConsume(
    queueName: NexxusQueueName,
    deliver: (delivery: NexxusMessageDelivery) => void
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

  // ---- Delivery handling ----

  /**
   * Process one delivery and settle it. Never rejects: it runs from the broker
   * client's event handler, where a rejection would end the process.
   */
  private async handleDelivery(
    queueName: NexxusQueueName,
    handler: (message: NexxusQueueMessage<any>) => Promise<void>,
    options: NexxusConsumeOptions,
    delivery: NexxusMessageDelivery
  ): Promise<void> {
    let outcome: NexxusDeliveryOutcome;

    try {
      // A message that arrives after `stopConsuming()` — the broker can still
      // be sending while the cancel is in flight — goes straight back.
      outcome = this.stopping ? 'requeue' : await this.processDelivery(queueName, handler, options, delivery);
    } catch (err) {
      // `processDelivery` handles the handler's failures itself; this is the
      // backstop for anything else.
      NexxusMessageQueueAdapter.logger.error(
        `Unexpected error processing a message from queue "${queueName}": ${NexxusMessageQueueAdapter.describeError(err)}`,
        NexxusMessageQueueAdapter.loggerLabel
      );
      outcome = 'requeue';
    }

    if (!delivery.isLive()) {
      return;
    }

    try {
      delivery[outcome]();
    } catch (err) {
      NexxusMessageQueueAdapter.logger.warn(
        `Could not settle a message from queue "${queueName}": ${NexxusMessageQueueAdapter.describeError(err)}`,
        NexxusMessageQueueAdapter.loggerLabel
      );
    }
  }

  /**
   * Run the handler until the message is done with, and say how to settle it:
   *
   *   - the handler resolves → ack
   *   - it fails with a `terminal` NexxusException → dead-letter, no retries
   *   - it fails while a service is down → wait for the service, retry, and
   *     don't count the failure: an outage isn't the message's fault
   *   - it fails otherwise → retry after each of `retryDelaysMs`, then
   *     dead-letter
   *   - consumption stops, or the delivery's connection goes away → requeue
   *
   * A payload that can't be decoded never will be, so it's dead-lettered too.
   */
  private async processDelivery(
    queueName: NexxusQueueName,
    handler: (message: NexxusQueueMessage<any>) => Promise<void>,
    options: NexxusConsumeOptions,
    delivery: NexxusMessageDelivery
  ): Promise<NexxusDeliveryOutcome> {
    const logger = NexxusMessageQueueAdapter.logger;
    const label = NexxusMessageQueueAdapter.loggerLabel;
    let message: NexxusQueueMessage<any>;

    try {
      message = { payload: await this.deserializePayload(delivery.content), metadata: delivery.metadata };
    } catch (err) {
      logger.error(
        `Giving up on a message from queue "${queueName}": it could not be decoded (${NexxusMessageQueueAdapter.describeError(err)})`,
        label
      );

      return 'deadLetter';
    }

    const event = (message.payload as { event?: unknown } | null)?.event;
    const what = `message${typeof event === 'string' ? ` "${event}"` : ''} from queue "${queueName}"`;
    let retries = 0;
    // Stays undefined for as long as the message is to be tried again.
    let outcome: NexxusDeliveryOutcome | undefined;

    do {
      try {
        await handler(message);

        outcome = 'ack';
      } catch (err) {
        const reason = NexxusMessageQueueAdapter.describeError(err);

        if (this.stopping || !delivery.isLive()) {
          outcome = 'requeue';
        } else if (err instanceof NexxusException && err.terminal) {
          logger.error(`Giving up on ${what}: ${reason}`, label);
          outcome = 'deadLetter';
        } else if (!options.isReady()) {
          logger.warn(`Retrying ${what} once every service is back; it failed while one was down: ${reason}`, label);

          if (!await this.whenReady(options) || !delivery.isLive()) {
            outcome = 'requeue';
          }
        } else if (retries === this.retryDelaysMs.length) {
          logger.error(`Giving up on ${what} after ${retries} retries: ${reason}`, label);
          outcome = 'deadLetter';
        } else {
          const wait = this.retryDelaysMs[retries]!;

          retries += 1;
          logger.warn(`Retrying ${what} in ${wait} ms (retry ${retries} of ${this.retryDelaysMs.length}): ${reason}`, label);

          if (!await this.delay(wait) || !delivery.isLive()) {
            outcome = 'requeue';
          }
        }
      }
    } while (outcome === undefined);

    return outcome;
  }

  /**
   * Wait `ms`, unless consumption stops first. Resolves `true` when the whole
   * wait elapsed, `false` when it was cut short.
   */
  private delay(ms: number): Promise<boolean> {
    return new Promise(resolve => {
      if (this.stopping) {
        resolve(false);

        return;
      }

      let timer: NodeJS.Timeout | undefined;
      const wake = (): void => {
        clearTimeout(timer);
        resolve(false);
      };

      timer = setTimeout(() => {
        this.stopWaiters.delete(wake);
        resolve(true);
      }, ms);
      this.stopWaiters.add(wake);
    });
  }

  /**
   * Wait until `options` reports every service up, unless consumption stops
   * first. Resolves like `delay`.
   */
  private whenReady(options: NexxusConsumeOptions): Promise<boolean> {
    return new Promise(resolve => {
      if (this.stopping) {
        resolve(false);

        return;
      }

      const wake = (): void => resolve(false);
      const ready = (): void => {
        this.stopWaiters.delete(wake);
        resolve(true);
      };

      this.stopWaiters.add(wake);
      void options.waitUntilReady().then(ready, ready);
    });
  }

  private static describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

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
