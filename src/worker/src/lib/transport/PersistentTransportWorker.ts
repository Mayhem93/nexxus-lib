import { NexxusBaseTransportWorker } from "./BaseTransportWorker";
import { NexxusBaseWorkerEvents, NexxusWorkerServices } from "../BaseWorker";

import { NexxusDevice } from '@mayhem93/nexxus-redis';
import { NexxusConfig } from '@mayhem93/nexxus-core-lib';

export type NexxusPersistentTransportWorkerConfig = NexxusConfig;

/**
 * Base class for transport workers that deliver via a 3rd-party push service
 * (APNs, FCM, web push, etc.) rather than a direct connection to the client device.
 *
 * Queue topology: all instances consume from a SHARED queue (no per-node suffix),
 * so they act as competing consumers — more instances simply mean more throughput
 * to the 3rd-party API. This is the default behavior inherited from
 * NexxusBaseTransportWorker; beforeConsume() is intentionally not overridden.
 *
 * Lifecycle: unlike volatile transports, device registration typically happens
 * out-of-band (via the API when the user supplies their push token), not via a
 * connection event in the worker. The helpers below are exposed for subclasses
 * that do need them — e.g. handling token-invalidated feedback from the 3rd-party
 * service to clean up dead subscriptions.
 *
 * Concrete subclasses must implement initTransport() (open HTTP/2 connection to
 * APNs, initialize an FCM client, etc.) and sendToDevice() (translate the
 * canonical NexxusTransportWorkerPayload data to the 3rd-party's wire format
 * and POST it).
 */
export abstract class NexxusPersistentTransportWorker<
  T extends NexxusPersistentTransportWorkerConfig,
  Ev extends NexxusBaseWorkerEvents = {},
> extends NexxusBaseTransportWorker<T, Ev> {

  protected static loggerLabel: Readonly<string> = "NxxPersistentTransport";

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  /**
   * Records a device as a persistent-flavor device in Redis. Available for subclasses
   * whose transport surfaces a registration signal (e.g. an MQTT broker notifying about
   * a new persistent session). For most persistent transports — APNs, FCM, web push —
   * registration is handled by the API at the time the device supplies its push token,
   * and this method is unused by the worker itself.
   */
  protected async registerDevice(deviceId: string): Promise<void> {
    await NexxusDevice.update(deviceId, {
      type: 'persistent',
      transport: this.queueName,
      status: 'online',
    });
  }

  /**
   * Called when the 3rd-party service signals that a device's token is permanently
   * invalid (e.g. APNs `Unregistered`, FCM `registration-token-not-registered`).
   * Tears down all subscriptions for the device and marks it offline in Redis.
   * Subclasses call this from their feedback-channel handling.
   *
   * Neither `lastSeen` nor `transport` is updated here. `lastSeen` is volatile-only.
   * `transport` is preserved so the device's flavor association stays visible even
   * after the token dies — consistent with the volatile counterpart.
   */
  protected async unregisterDevice(deviceId: string): Promise<void> {
    await NexxusDevice.removeAllSubscriptions(deviceId);
    await NexxusDevice.update(deviceId, {
      status: 'offline',
    });
  }
}
