import { FatalErrorException, NexxusHubNode } from '@mayhem93/nexxus-core-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';

import {
  NexxusBaseTransportWorker,
  NexxusBaseTransportWorkerConfig,
  NexxusBaseTransportWorkerStats
} from './BaseTransportWorker';
import {
  NexxusBaseWorker,
  NexxusBaseWorkerEvents,
  NexxusWorkerServices
} from '../BaseWorker';

export type NexxusVolatileTransportWorkerConfig = NexxusBaseTransportWorkerConfig & {};

export type NexxusVolatileTransportWorkerStats = NexxusBaseTransportWorkerStats & {};
export abstract class NexxusVolatileTransportWorker<
  T extends NexxusVolatileTransportWorkerConfig,
  Ev extends NexxusBaseWorkerEvents = {},
  S extends NexxusVolatileTransportWorkerStats = NexxusVolatileTransportWorkerStats
> extends NexxusBaseTransportWorker<T, Ev, S> {

  protected static loggerLabel: Readonly<string> = 'NxxVolatileTransport';

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  /**
   * Volatile transports route per node: each worker instance consumes from its own
   * per-slot queue (e.g. `websockets-transport_3`) so the Transport Manager can
   * target the exact node holding a given device's live connection.
   *
   * Slot picking flow (runs before the base's queue-consume + Hub-register):
   *
   *   Hub configured:
   *     1. Ask Hub which slots are taken for this role.
   *     2. Pick the lowest unused number starting at 0 (gap detection, so churn
   *        doesn't drift the slot index unboundedly upward).
   *     3. Append `_<slot>` to `this.queueName` — from then on that's the
   *        source of truth for our slot, parsed back out by `buildHubPayload`
   *        when registering / re-registering.
   *
   *   No Hub (dev-only shortcut):
   *     Default to slot 0. Broker-level exclusivity on the queue is what
   *     catches accidental "two workers, no Hub, both slot 0" cases —
   *     `createVolatileQueue` declares the queue as `exclusive`, so the second
   *     worker's assertQueue fails with RESOURCE_LOCKED and we throw. In
   *     production, `config.hub` should always be present.
   *
   * In either mode: declare the per-slot queue on the broker (non-durable +
   * auto-delete + exclusive for RabbitMQ; broker-specific for others — see the
   * adapter contract). Slot collisions from a Hub race (two workers both saw
   * slot 3 as free between listNodesByRole and register) get caught here too,
   * via the same exclusivity check.
   */
  protected async beforeConsume(): Promise<void> {
    let slot = 0;

    if (this.hubClient) {
      const peers = await this.hubClient.listNodesByRole(this.nodeRole);
      const usedSlots = new Set(
        peers.map((n) => n.slot).filter((s): s is number => typeof s === 'number'),
      );

      while (usedSlots.has(slot)) slot++;
    } else {
      NexxusVolatileTransportWorker.logger.warn(
        'No Hub configured — defaulting to slot 0. Dev-only shortcut; production deployments must have a Hub. ' +
        'A second worker declaring the same slot will fail broker-side (RESOURCE_LOCKED on the exclusive queue).',
        NexxusVolatileTransportWorker.loggerLabel,
      );
    }

    this.queueName = `${this.queueName}_${slot}`;

    // Friendly pre-check: give a clear "slot taken" error before falling
    // back on the broker's less-legible collision response. Not atomic
    // (a peer could claim the slot between here and createVolatileQueue),
    // so the exclusive-queue enforcement in the adapter is still what
    // makes the race safe.
    if (await NexxusBaseWorker.messageQueue.queueExists(this.queueName)) {
      throw new FatalErrorException(
        `Volatile transport slot ${slot} already taken — queue ${this.queueName} exists on the broker`
      );
    }

    await NexxusBaseWorker.messageQueue.createVolatileQueue(this.queueName);

    NexxusVolatileTransportWorker.logger.info(
      `Picked slot ${slot} — consuming from ${this.queueName}`,
      NexxusVolatileTransportWorker.loggerLabel,
    );
  }

  /**
   * Extend the base Hub payload with our slot number, parsed from the
   * `_<slot>` suffix `beforeConsume()` appended to `queueName`. Called by
   * the base's registerNode flow (both initial and periodic re-register),
   * so a Hub restart mid-life picks the same slot back up as long as we're
   * still running.
   */
  protected async buildHubPayload(pendingNodeId: string): Promise<NexxusHubNode> {
    const base = await super.buildHubPayload(pendingNodeId);
    const match = this.queueName.match(/_(\d+)$/);

    return {
      ...base,
      slot: match ? parseInt(match[1], 10) : undefined,
    };
  }

  /**
   * Delete our per-slot queue on shutdown so the slot number becomes
   * available to future workers. For RabbitMQ the exclusive+auto-delete
   * combo usually beats us to it once the channel closes; we call
   * `deleteQueue` explicitly anyway (safe if already gone) so brokers
   * without auto-delete semantics behave consistently.
   */
  public async close(): Promise<void> {
    try {
      await NexxusBaseWorker.messageQueue.deleteQueue(this.queueName);
    } catch (err) {
      NexxusVolatileTransportWorker.logger.warn(
        `Failed to delete slot queue ${this.queueName} on shutdown: ${(err as Error).message}`,
        NexxusVolatileTransportWorker.loggerLabel,
      );
    }

    await super.close();
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
