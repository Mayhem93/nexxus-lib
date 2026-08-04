import {
  ConfigCliArgs,
  ConfigEnvVars,
  INexxusBaseServices,
  NexxusQueueName,
  NexxusQueuePayload,
} from '@mayhem93/nexxus-core-lib';
import {
  NexxusMessageQueueAdapter,
  NexxusMessageQueueAdapterEvents,
  NexxusMessageQueueAdapterStats,
  NexxusMessageQueueConfig,
  NexxusQueueMessage
} from './MessageQueueAdapter';
import {
  NexxusRabbitMqBootstrapper,
  NexxusRabbitMqBootstrapOptions,
} from './RabbitMqBootstrapper';

import * as amqplib from 'amqplib';

import * as path from 'node:path';

type RabbitMQConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  managementPort: number;
} & NexxusMessageQueueConfig;

export type RabbitMqMetadata = {
  fields: amqplib.MessageFields;
  properties: amqplib.MessageProperties;
};

interface NexxusRabbitMqEvents extends NexxusMessageQueueAdapterEvents {}

/**
 * RabbitMQ-specific stats. `amqplib` doesn't expose queue-level introspection
 * (that needs the RabbitMQ management plugin's HTTP API on port 15672,
 * which is a separate dependency we haven't taken). So this is intentionally
 * lean for v1 — connection state plus broker identity when available.
 * Full queue/exchange enumeration is future work.
 */
export type NexxusRabbitMqStats = NexxusMessageQueueAdapterStats & {
  connected: boolean;
  channelOpen?: boolean;
  brokerProduct?: string;
  brokerVersion?: string;
};

export class NexxusRabbitMq extends NexxusMessageQueueAdapter<RabbitMQConfig, NexxusRabbitMqEvents, NexxusRabbitMqStats> {
  protected static loggerLabel: Readonly<string> = 'NxxRabbitMq';
  protected static schemaPath: string = path.join(__dirname, '../../src/schemas/rabbitmq.schema.json');
  protected static envVars: ConfigEnvVars = [
    { name: 'MQ_HOST',     location: 'host',     type: 'string' },
    { name: 'MQ_PORT',     location: 'port',     type: 'int' },
    { name: 'MQ_USER',     location: 'user',     type: 'string' },
    { name: 'MQ_PASSWORD', location: 'password', type: 'string' }
  ];

  protected static cliArgs: ConfigCliArgs = [];
  protected reconnectDelayMs: number = 5000; //TODO: make this configurable

  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;

  /**
   * amqplib consumer tags keyed by queue name. Populated by `doConsume`
   * on each `channel.consume()` call, drained by `doCancelAll`. Cleared
   * on channel close as well — a fresh channel will get fresh tags via
   * the base's auto-restore path after reconnect.
   */
  private consumerTags: Map<NexxusQueueName, string> = new Map();

  constructor(services: INexxusBaseServices) {
    super(services);
  }

  public getBootstrapper(options: NexxusRabbitMqBootstrapOptions): NexxusRabbitMqBootstrapper {
    // No connect() prerequisite — the bootstrapper runs entirely over the
    // management HTTP API. That's the point: it's what creates the vhost
    // this adapter's AMQP layer will later connect to.
    return new NexxusRabbitMqBootstrapper(options, this.config);
  }

  /**
   * Open the AMQP connection + channel and wire close/error handlers back
   * into the base's retry loop via `onConnectionLost()`. The base owns
   * everything upstream — retry timing, resolver bookkeeping, event
   * emission. Throwing here just re-arms the retry timer (or trips the
   * fatal branch, via `isFatalConnectError()`).
   */
  protected async doConnect(): Promise<void> {
    const connection = await amqplib.connect({
      protocol: 'amqp',
      hostname: this.config.host,
      port: this.config.port,
      username: this.config.user,
      password: this.config.password,
      vhost: '/nexxus',
      heartbeat: 10
    });

    const channel = await connection.createChannel();

    connection.on('error', (err) => {
      NexxusRabbitMq.logger.error(`RabbitMQ connection error: ${err.message}`, NexxusRabbitMq.loggerLabel);
      // amqplib emits 'close' right after 'error'; the close handler owns
      // reconnection so we don't call onConnectionLost() from here.
    });

    connection.once('close', () => {
      this.connection = null;
      this.channel = null;
      // The channel is dead — any consumer tags we tracked against it
      // are meaningless now. The base's auto-restore path repopulates
      // them via doConsume() after the next reconnect.
      this.consumerTags.clear();
      this.onConnectionLost();
    });

    this.connection = connection;
    this.channel = channel;
  }

  protected async doDisconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();

      this.connection = null;
      this.channel = null;
    }
  }

  /**
   * Which handshake errors are worth retrying and which mean "give up."
   *
   * RabbitMQ reports auth-refused and missing-vhost both as 403
   * ACCESS-REFUSED, but with different trailing messages:
   *   - "Login was refused..."   → bad creds; not going to fix itself.
   *   - "vhost <name> refused..." → the bootstrapper will create it, retry.
   *
   * Match on the auth message specifically; anything else (network errors,
   * broker-not-ready, unrecognized handshake failures) defaults to
   * retryable — see the base's contract for `isFatalConnectError()`.
   */
  protected isFatalConnectError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);

    return /Login was refused/i.test(msg);
  }

  /**
   * Lean by design — amqplib doesn't offer queue/exchange introspection
   * without the RabbitMQ management HTTP API. What we CAN report cheaply
   * from the client itself: whether the connection and channel are open,
   * and the server-advertised broker identity from the AMQP handshake.
   *
   * `serverProperties` lives on amqplib's internal `Connection` object; we
   * access it via the ChannelModel's underlying connection. Falls back to
   * `undefined` if the shape changes in a future amqplib release.
   */
  public getStats(): Promise<NexxusRabbitMqStats> {
    if (!this.connection) {
      return Promise.resolve({ id: 'unknown', connected: false });
    }

    // TODO: actually use the rabbitmq management HTTP API to get queue/exchange stats, if we want to report more than just connection state
    const serverProps = (this.connection as any).connection?.serverProperties as {
      product?: string;
      version?: string;
    } | undefined;

    return Promise.resolve({
      id: this.config.host,
      connected: true,
      channelOpen: this.channel !== null,
      brokerProduct: serverProps?.product,
      brokerVersion: serverProps?.version,
    });
  }

  public async publishMessage<Q extends NexxusQueueName>(
    queueName: Q,
    message: NexxusQueuePayload<Q>,
    metadata?: amqplib.Options.Publish
  ): Promise<void> {
    // `serializePayload` on the base handles JSON encode + optional
    // compression per the adapter's config. Content-type reflects the
    // post-compression wire shape so any inspector (RabbitMQ management
    // UI, tracing) knows not to try JSON-parsing the raw bytes.
    const messageBuffer = await this.serializePayload(message);

    NexxusRabbitMq.logger.debug(
      `Publishing message to RabbitMQ queue ${queueName} (${messageBuffer.length} bytes${this.compressor ? ', compressed' : ''})`,
      NexxusRabbitMq.loggerLabel,
    );

    const options : amqplib.Options.Publish = {
      persistent: true,
      contentType: this.compressor ? 'application/octet-stream' : 'application/json',
      ...metadata || {}
    };

    this.channel?.sendToQueue(queueName, messageBuffer, options);
  }

  public async queueExists(name: string): Promise<boolean> {
    if (!this.connection) {
      throw new Error('RabbitMQ connection not available — call connect() before queueExists()');
    }

    // `checkQueue` is amqplib's passive declare — it throws (and closes the
    // channel) if the queue doesn't exist, exists on a different connection
    // as exclusive, or hits any other broker-side error. Run it on a
    // throwaway channel so a NOT_FOUND doesn't kill the main channel.
    // For the volatile-transport pre-check, either kind of "we can't use it"
    // outcome (missing vs locked) is fine — the caller only cares whether
    // this slot is safe to grab.
    let tempChannel: amqplib.Channel | null = null;

    try {
      tempChannel = await this.connection.createChannel();

      // Absorb channel-level 'error' events. `checkQueue` on a non-existent
      // queue triggers a channel error (404 NOT_FOUND); without a listener
      // to catch it here, amqplib escalates the unhandled channel-emitted
      // 'error' into a full CONNECTION teardown — which nulls out
      // `this.channel` via our close handler, so any subsequent adapter
      // call sees "channel not available". The no-op listener is enough:
      // we still surface the error via the rejected `checkQueue` promise
      // in the catch below.
      tempChannel.on('error', () => { /* absorbed */ });

      await tempChannel.checkQueue(name);

      return true;
    } catch (err) {
      // amqplib surfaces broker channel errors with a numeric `code`:
      //   404 NOT_FOUND        → queue doesn't exist; safe to create.
      //   405 RESOURCE_LOCKED  → exists as exclusive on another connection.
      // Anything else we don't recognize is treated as "not safe to grab"
      // — over-reporting existence is the safer failure mode here (the
      // worker will refuse to steal the slot).
      const errCode = (err as { code?: number })?.code;

      if (errCode === 404) {
        return false;
      }

      return true;
    } finally {
      if (tempChannel) {
        try { await tempChannel.close(); } catch { /* already closed on error */ }
      }
    }
  }

  public async createVolatileQueue(name: string): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not available — call connect() before createVolatileQueue()');
    }

    // `exclusive` does double duty here:
    //   1. Only this connection can consume from the queue — the slot
    //      identity is tied to the owning worker.
    //   2. Two workers racing for the same slot number both call
    //      assertQueue — the second one gets RESOURCE_LOCKED from the
    //      broker, which is exactly the collision-detection signal we
    //      want. Propagates up as a thrown error.
    // `autoDelete` + no `durable` are implied by `exclusive` in practice,
    // but stated explicitly so the intent is readable at the call site.
    // No `x-queue-type: quorum` — quorum queues aren't compatible with
    // non-durable / exclusive semantics. Classic queue is right here.
    await this.channel.assertQueue(name, {
      durable: false,
      autoDelete: true,
      exclusive: true
    });

    NexxusRabbitMq.logger.info(
      `Declared volatile queue ${name}`,
      NexxusRabbitMq.loggerLabel,
    );
  }

  public async deleteQueue(name: string): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not available — call connect() before deleteQueue()');
    }

    // Safe if the queue has already gone (auto-delete usually beats us to it).
    // `deleteQueue` returns { messageCount } on success; RabbitMQ swallows a
    // NOT_FOUND at the protocol level so we don't have to translate errors.
    await this.channel.deleteQueue(name);

    NexxusRabbitMq.logger.info(
      `Deleted queue ${name}`,
      NexxusRabbitMq.loggerLabel,
    );
  }

  /**
   * amqplib entry point for actually starting a consumer. Called by the
   * base's `consumeMessages` on initial registration, by `resumeConsuming`
   * on external unpause, and by `tryOnce`'s auto-restore on reconnect.
   * The returned consumer tag is stashed keyed by queue name so
   * `doCancelAll` can address it later.
   */
  protected async doConsume(
    queueName: NexxusQueueName,
    onMessage: (message: NexxusQueueMessage<any>) => Promise<void>
  ): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not available — call connect() before doConsume()');
    }

    const { consumerTag } = await this.channel.consume(queueName, async msg => {
      if (msg !== null) {
        // `deserializePayload` on the base handles decompression (when
        // enabled) + JSON.parse, so compression policy stays in one place.
        const payload = await this.deserializePayload<any>(msg.content);
        const metadata: RabbitMqMetadata = {
          fields: msg.fields,
          properties: msg.properties,
        };
        const queueMessage: NexxusQueueMessage<any> = {
          payload,
          metadata,
        };

        NexxusRabbitMq.logger.debug(`Received message from RabbitMQ queue ${queueName}: ${msg.content.toString()}`, NexxusRabbitMq.loggerLabel);

        await onMessage(queueMessage);

        this.channel?.ack(msg);
      }
    });

    this.consumerTags.set(queueName, consumerTag);
  }

  /**
   * Cancel every tracked consumer on the current channel. Errors on
   * individual `channel.cancel` calls are logged and swallowed —
   * failing to cancel doesn't block pauseConsuming. Tags are always
   * cleared so a subsequent doConsume registers fresh.
   */
  protected async doCancelAll(): Promise<void> {
    if (!this.channel) {
      this.consumerTags.clear();

      return;
    }

    for (const [queue, tag] of this.consumerTags) {
      try {
        await this.channel.cancel(tag);
      } catch (err) {
        NexxusRabbitMq.logger.warn(
          `Failed to cancel consumer tag ${tag} for queue "${queue}": ${(err as Error).message}`,
          NexxusRabbitMq.loggerLabel,
        );
      }
    }

    this.consumerTags.clear();
  }
}
