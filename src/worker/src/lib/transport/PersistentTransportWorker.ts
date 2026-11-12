import { SessionEndedException } from '@mayhem93/nexxus-core-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';

import {
  NexxusBaseTransportWorker,
  NexxusBaseTransportWorkerConfig,
  NexxusBaseTransportWorkerStats
} from './BaseTransportWorker';
import {
  NexxusBaseWorkerEvents,
  NexxusWorkerServices
} from '../BaseWorker';

export type NexxusPersistentTransportWorkerConfig = NexxusBaseTransportWorkerConfig & {};

export type NexxusPersistentTransportWorkerStats = NexxusBaseTransportWorkerStats & {};

/**
 * Base class for transport workers that deliver via a 3rd-party push service
 * (APNs, FCM, web push, etc.) rather than a direct connection to the client device.
 *
 * Queue topology: all instances consume from a SHARED queue (no per-node suffix),
 * so they act as competing consumers — more instances simply mean more throughput
 * to the 3rd-party API. This is the default behavior inherited from
 * NexxusBaseWorker; beforeConsume() is intentionally not overridden.
 *
 * Lifecycle: unlike volatile transports, device registration typically happens
 * out-of-band (via the API when the user supplies their push token), not via a
 * connection event in the worker. The helpers below are exposed for subclasses
 * that do need them — e.g. handling token-invalidated feedback from the 3rd-party
 * service to clean up dead subscriptions.
 *
 * Concrete subclasses must implement initTransport() (open HTTP/2 connection to
 * APNs, initialize an FCM client, etc.) and sendToConnection() (translate the
 * canonical NexxusTransportDeviceMessagePayload data to the 3rd-party's wire format
 * and POST it to the push token the connection id is).
 */
export abstract class NexxusPersistentTransportWorker<
  T extends NexxusPersistentTransportWorkerConfig,
  Ev extends NexxusBaseWorkerEvents = {},
  S extends NexxusPersistentTransportWorkerStats = NexxusPersistentTransportWorkerStats
> extends NexxusBaseTransportWorker<T, Ev, S> {

  protected static loggerLabel: Readonly<string> = 'NxxPersistentTransport';

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  /**
   * Opens a persistent connection of a device in Redis, on this transport's
   * queue; its id is the device's push token. Available for subclasses whose
   * transport surfaces a registration signal (e.g. an MQTT broker notifying
   * about a new persistent session). For most persistent transports — APNs,
   * FCM, web push — registration is handled by the API at the time the device
   * supplies its push token, and this method is unused by the worker itself.
   *
   * Throws `SessionEndedException` when the device's session has ended.
   */
  protected async registerConnection(deviceId: string, connectionId: string): Promise<void> {
    if (!await NexxusDevice.openConnection(deviceId, connectionId, { transport: this.queueName, type: 'persistent' })) {
      throw new SessionEndedException('The session of this device has ended.');
    }
  }

  /**
   * Called when the 3rd-party service signals that a push token is permanently
   * invalid (e.g. APNs `Unregistered`, FCM `registration-token-not-registered`).
   * Tears that connection down in Redis: its routes, then its entry. Subclasses
   * call this from their feedback-channel handling.
   */
  protected async unregisterConnection(deviceId: string, connectionId: string): Promise<void> {
    await NexxusDevice.closeConnection(deviceId, connectionId);
  }
}
