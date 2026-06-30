import { NexxusBaseTransportWorker } from "./BaseTransportWorker";
import { NexxusBaseWorkerEvents, NexxusWorkerServices } from "../BaseWorker";

import { NexxusDevice } from '@mayhem93/nexxus-redis';
import { NexxusConfig } from '@mayhem93/nexxus-core-lib';

export type NexxusVolatileTransportWorkerConfig = NexxusConfig & {
  workerId?: number;
};

export abstract class NexxusVolatileTransportWorker<
  T extends NexxusVolatileTransportWorkerConfig,
  Ev extends NexxusBaseWorkerEvents = {},
> extends NexxusBaseTransportWorker<T, Ev> {

  protected static loggerLabel: Readonly<string> = "NxxVolatileTransport";

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  /**
   * Volatile transports route per node: each worker instance consumes from its own queue
   * (e.g. `websockets-transport_1`) so the Transport Manager can target the exact node
   * that holds a given device's live connection.
   */
  protected async beforeConsume(): Promise<void> {
    this.queueName += `_${this.config.workerId || 1}`;
  }

  /**
   * Called by the subclass when a client successfully registers itself with a deviceId
   * (via whatever protocol-specific handshake the subclass implements).
   * Records the volatile-flavor device state in Redis.
   */
  protected async registerDevice(deviceId: string): Promise<void> {
    await NexxusDevice.update(deviceId, {
      lastSeen: new Date(),
      type: 'volatile',
      transport: this.queueName,
      status: 'online',
    });
  }

  /**
   * Called by the subclass when a client disconnects (whatever "disconnect" means in its protocol).
   * Tears down all subscriptions for the device and marks it offline in Redis.
   * Note: `transport` is intentionally not cleared — once a device is classified by a transport,
   * that association persists so we can still see which worker pool the device lives on.
   */
  protected async unregisterDevice(deviceId: string): Promise<void> {
    await NexxusDevice.removeAllSubscriptions(deviceId);
    await NexxusDevice.update(deviceId, {
      lastSeen: new Date(),
      status: 'offline',
      transport: null
    });
  }
}
