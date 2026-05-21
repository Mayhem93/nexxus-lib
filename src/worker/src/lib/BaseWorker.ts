import {
  NexxusBaseService,
  INexxusBaseServices,
  NexxusConfig,
  NexxusQueueName,
  NexxusQueuePayload,
  NexxusBaseQueuePayload,
  NexxusBaseLogger,
  FatalErrorException,
  NexxusApplication,
  MODEL_REGISTRY
} from '@mayhem93/nexxus-core-lib';
import {
  NexxusDatabaseAdapter,
  NexxusDatabaseAdapterEvents
} from '@mayhem93/nexxus-database-lib';
import {
  NexxusMessageQueueAdapter,
  NexxusMessageQueueAdapterEvents,
  NexxusQueueMessage
} from '@mayhem93/nexxus-message-queue-lib';
import { NexxusRedis } from '@mayhem93/nexxus-redis';

import * as Dot from 'dot-prop';

export type NexxusBaseWorkerEvents = Record<string, any[]>;

export interface NexxusWorkerServices extends INexxusBaseServices {
  database: NexxusDatabaseAdapter<NexxusConfig, NexxusDatabaseAdapterEvents>;
  messageQueue: NexxusMessageQueueAdapter<NexxusConfig, NexxusMessageQueueAdapterEvents>;
  redis: NexxusRedis;
};

export abstract class NexxusBaseWorker<T extends NexxusConfig, Ev extends NexxusBaseWorkerEvents = {}, TPayload extends NexxusBaseQueuePayload = NexxusBaseQueuePayload>
  extends NexxusBaseService<T, Ev extends NexxusBaseWorkerEvents ? Ev : NexxusBaseWorkerEvents> {

  public static logger: NexxusBaseLogger<any>;

  protected initialized: boolean = false;
  protected static loggerLabel: Readonly<string> = "NxxWorker";
  protected static readonly loadedApps: Map<string, NexxusApplication> = new Map();
  protected abstract queueName: NexxusQueueName;

  public static database: NexxusDatabaseAdapter<NexxusConfig, NexxusDatabaseAdapterEvents>;
  public static messageQueue: NexxusMessageQueueAdapter<NexxusConfig, NexxusMessageQueueAdapterEvents>;
  public static redis: NexxusRedis;

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
  }

  public async init() : Promise<void> {
    await NexxusBaseWorker.loadApps();
    await NexxusBaseWorker.messageQueue.consumeMessages(this.queueName, this.processMessage.bind(this) as any);
    this.initialized = true;
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
