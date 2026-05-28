import {
  NexxusBaseWorker,
  NexxusBaseWorkerEvents,
  NexxusWorkerServices
} from "../BaseWorker";

import {
  NexxusBaseQueuePayload,
  NexxusConfig,
  NexxusTransportWorkerPayload
} from '@mayhem93/nexxus-core-lib';
import { NexxusQueueMessage } from '@mayhem93/nexxus-message-queue-lib';

export abstract class NexxusBaseTransportWorker<
  T extends NexxusConfig,
  Ev extends NexxusBaseWorkerEvents = {},
> extends NexxusBaseWorker<T, Ev, NexxusTransportWorkerPayload> {

  protected static loggerLabel: Readonly<string> = "NxxTransport";

  protected initialized: boolean = false;

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  public async init(): Promise<void> {
    const label = (this.constructor as typeof NexxusBaseTransportWorker).loggerLabel;

    if (this.initialized) {
      NexxusBaseTransportWorker.logger.warn(
        `${this.constructor.name} already initialized`,
        label
      );

      return;
    }

    await this.beforeConsume();
    await super.init();
    await this.initTransport();

    this.initialized = true;
  }

  /**
   * Hook called before this.queueName is bound to the message queue consumer.
   * Subclasses can mutate this.queueName or do any other pre-consume setup
   * (e.g. NexxusVolatileTransportWorker uses this to append the worker ID suffix).
   * Default: no-op.
   */
  protected async beforeConsume(): Promise<void> {}

  /**
   * Subclass binds its transport-specific listener or service connection.
   * Called once during init, after the message queue consumer is wired.
   */
  protected abstract initTransport(): Promise<void>;

  /**
   * Subclass delivers the event to the device via its specific transport mechanism.
   * Called by processMessage for each deviceId in an incoming device_message payload.
   * Subclass owns the "no live handle / no valid token" decision (typically log a warn).
   *
   * `data` is the canonical transport payload's data union; subclass discriminates
   * on `data.event` via a switch and TS narrows each case to the matching variant.
   */
  protected abstract sendToDevice(deviceId: string, data: NexxusTransportWorkerPayload['data']): Promise<void>;

  protected async processMessage(msg: NexxusQueueMessage<NexxusTransportWorkerPayload>): Promise<void> {
    const payload = msg.payload;
    const label = (this.constructor as typeof NexxusBaseTransportWorker).loggerLabel;

    if (payload.event !== 'device_message') {
      NexxusBaseTransportWorker.logger.warn(
        `Unknown event type: ${(payload as NexxusBaseQueuePayload).event}`,
        label
      );

      return;
    }

    if (payload.deviceIds.length === 0) {
      NexxusBaseTransportWorker.logger.warn(
        'No device IDs provided in device_message payload',
        label
      );

      return;
    }

    const data = payload.data;

    for (const deviceId of payload.deviceIds) {
      await this.sendToDevice(deviceId, data);
    }
  }
}
