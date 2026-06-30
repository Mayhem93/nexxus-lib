import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusConfig,
  INexxusBaseServices,
  NexxusQueueName,
  NexxusQueuePayload,
  FatalErrorException,
} from "@mayhem93/nexxus-core-lib";
import {
  NexxusMessageQueueAdapter,
  NexxusMessageQueueAdapterEvents,
  NexxusQueueMessage
} from "./MessageQueueAdapter";

import * as amqplib from "amqplib";

import * as path from "node:path";

type RabbitMQConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  exclusive: boolean;
  worker_name: string;
} & NexxusConfig;

export type RabbitMqMetadata = {
  fields: amqplib.MessageFields;
  properties: amqplib.MessageProperties;
};

interface NexxusRabbitMqEvents extends NexxusMessageQueueAdapterEvents {}

export class NexxusRabbitMq extends NexxusMessageQueueAdapter<RabbitMQConfig, NexxusRabbitMqEvents> {
  protected static loggerLabel: Readonly<string> = "NxxRabbitMq";
  protected static schemaPath: string = path.join(__dirname, "../../src/schemas/rabbitmq.schema.json");
  protected static envVars: ConfigEnvVars = [
    { name: "MQ_HOST",     location: "host" },
    { name: "MQ_PORT",     location: "port" },
    { name: "MQ_USER",     location: "user" },
    { name: "MQ_PASSWORD", location: "password" }
  ];

  protected static cliArgs: ConfigCliArgs = [];
  protected reconnectDelayMs: number = 5000; //TODO: make this configurable

  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;

  constructor(services: INexxusBaseServices) {
    super(services);
  }

  async connect(): Promise<void> {
    try {
      this.connection = await amqplib.connect({
        protocol: 'amqp',
        hostname: this.config.host,
        port: this.config.port,
        username: this.config.user,
        password: this.config.password,
        vhost: '/nexxus',
        heartbeat: 10
      });
    } catch (err) {
      if (err.name === 'AggregateError') {
        throw new FatalErrorException(`Failed to connect to RabbitMQ server: ${(err as Error).message}`);
      }

      throw err;
    }

    this.connection.on('error', (err) => {
      NexxusRabbitMq.logger.error(`RabbitMQ connection error: ${err.message}`, NexxusRabbitMq.loggerLabel);

      this.reConnect().catch(reconnectErr => {
        NexxusRabbitMq.logger.error(`Failed to reconnect to RabbitMQ: ${reconnectErr.message}`, NexxusRabbitMq.loggerLabel);
      });
    });

    this.channel = await this.connection.createChannel();

    NexxusRabbitMq.logger.info("Connected to RabbitMQ server", NexxusRabbitMq.loggerLabel);
  }

  async reConnect(): Promise<void> {
    // Implementation for reconnecting to RabbitMQ
  }

  async disconnect(): Promise<void> {
    if(this.connection) {
      await this.connection.close();

      this.connection = null;
    }
  }

  async publishMessage<Q extends NexxusQueueName>(
    queueName: Q,
    message: NexxusQueuePayload<Q>,
    metadata?: amqplib.Options.Publish
  ): Promise<void> {
    // Implementation for publishing a message to a RabbitMQ queue
    const messageBuffer = Buffer.from(JSON.stringify(message));

    // TODO: remove queue assertions when implementing a rabbitmq bootstrap process
    /* const res = await this.channel?.assertQueue(queueName, { durable: true, arguments: { 'x-queue-type': 'quorum' } });

    if (res === undefined) {
      throw new FatalErrorException(`Failed to assert RabbitMQ queue ${queueName}`);
    }

    NxxSvcs.logger.debug(`Asserted RabbitMQ queue ${res.queue}`, NexxusRabbitMq.loggerLabel); */

    NexxusRabbitMq.logger.debug(`Publishing message to RabbitMQ queue ${queueName}: ${messageBuffer.toString()}`, NexxusRabbitMq.loggerLabel);

    const options : amqplib.Options.Publish = {
      persistent: true,
      contentType: 'application/json',
      ...metadata || {}
    };

    this.channel?.sendToQueue(queueName, messageBuffer, options);
  }

  async consumeMessages<Q extends NexxusQueueName>(
    queueName: Q,
    onMessage: (message: NexxusQueueMessage<NexxusQueuePayload<Q>>) => Promise<void>
  ) : Promise<void> {
    await this.channel?.consume(queueName, async msg => {
      if (msg !== null) {
        const payload = JSON.parse(msg.content.toString()) as NexxusQueuePayload<Q>;
        const metadata : RabbitMqMetadata = {
          fields: msg.fields,
          properties: msg.properties
        };
        const queueMessage : NexxusQueueMessage<NexxusQueuePayload<Q>> = {
          payload,
          metadata
        };

        NexxusRabbitMq.logger.debug(`Received message from RabbitMQ queue ${queueName}: ${msg.content.toString()}`, NexxusRabbitMq.loggerLabel);

        await onMessage(queueMessage);

        this.channel?.ack(msg);
      }
    });

    return Promise.resolve();
  }
}
