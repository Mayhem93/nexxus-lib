import {
  NexxusConfig,
  NexxusBaseService,
  INexxusBaseServices,
  NexxusBaseLogger,
  NexxusQueueName,
  NexxusQueuePayload,
  NexxusBaseQueuePayload,
} from "@mayhem93/nexxus-core-lib";

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

  protected static configRootKey: string = "message_queue";
  protected static loggerLabel: Readonly<string> = "NxxMessageQueue";
  protected abstract reconnectDelayMs: number;

  protected static logger: NexxusBaseLogger<any>;

  constructor(services: INexxusBaseServices) {
    super(services.configManager.getConfig('message_queue') as T);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new Error('Logger service is not an instance of NexxusBaseLogger');
    }

    NexxusMessageQueueAdapter.logger = services.logger;
  }

  abstract connect(): Promise<void>;
  abstract reConnect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  abstract publishMessage<Q extends NexxusQueueName>(
    queueName: Q,
    message: NexxusQueuePayload<Q>,
    metadata?: Record<string, any>
  ): Promise<void>;

  abstract consumeMessages<Q extends NexxusQueueName>(
    queueName: Q,
    onMessage: (message: NexxusQueueMessage<NexxusQueuePayload<Q>>) => Promise<void>
  ) : Promise<void>;
}
