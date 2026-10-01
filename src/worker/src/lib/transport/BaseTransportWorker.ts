import {
  NexxusBaseQueuePayload,
  NexxusTransportDeviceMessagePayload,
  NexxusTransportWorkerPayload
} from '@mayhem93/nexxus-core-lib';
import { NexxusQueueMessage } from '@mayhem93/nexxus-message-queue-lib';

import {
  NexxusBaseWorker,
  NexxusBaseWorkerEvents,
  NexxusBaseWorkerConfig,
  NexxusBaseWorkerStats,
  NexxusWorkerServices
} from '../BaseWorker';

export type NexxusBaseTransportWorkerConfig = NexxusBaseWorkerConfig & {}

export type NexxusBaseTransportWorkerStats = NexxusBaseWorkerStats & {}

export abstract class NexxusBaseTransportWorker<
  T extends NexxusBaseTransportWorkerConfig,
  Ev extends NexxusBaseWorkerEvents = {},
  S extends NexxusBaseTransportWorkerStats = NexxusBaseTransportWorkerStats
> extends NexxusBaseWorker<T, Ev, NexxusTransportWorkerPayload, S> {

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

    await super.init();
    await this.initTransport();

    this.initialized = true;
  }

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
  protected abstract sendToDevice(deviceId: string, data: NexxusTransportDeviceMessagePayload['data']): Promise<void>;

  /**
   * End the live connections of devices whose sessions were ended by logout.
   *
   * Only a volatile transport holds a connection to end, and the API sends
   * `device_logout` to volatile transports only — so reaching this default means
   * a message went somewhere it has no meaning.
   */
  protected async handleDeviceLogout(deviceIds: Array<string>): Promise<void> {
    NexxusBaseTransportWorker.logger.warn(
      `Received device_logout for ${deviceIds.length} device(s), but this transport holds no connections`,
      (this.constructor as typeof NexxusBaseTransportWorker).loggerLabel
    );
  }

  protected async processMessage(msg: NexxusQueueMessage<NexxusTransportWorkerPayload>): Promise<void> {
    const payload = msg.payload;
    const label = (this.constructor as typeof NexxusBaseTransportWorker).loggerLabel;

    if (payload.event === 'device_logout') {
      await this.handleDeviceLogout(payload.deviceIds);

      return;
    }

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
