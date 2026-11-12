import {
  FatalErrorException,
  InvalidTokenException,
  NexxusHubNode,
  NexxusToken,
  NexxusTransportRecipient,
  SessionEndedException
} from '@mayhem93/nexxus-core-lib';
import { NexxusDevice, type NexxusDeviceConnection } from '@mayhem93/nexxus-redis';

import {
  NexxusBaseTransportWorker,
  NexxusBaseTransportWorkerConfig,
  NexxusBaseTransportWorkerStats
} from './BaseTransportWorker';
import {
  NexxusBaseWorker,
  NexxusBaseWorkerEvents,
  NexxusWorkerServices,
  NexxusWorkerServiceName
} from '../BaseWorker';

export type NexxusVolatileTransportWorkerConfig = NexxusBaseTransportWorkerConfig & {};

export type NexxusVolatileTransportWorkerStats = NexxusBaseTransportWorkerStats & {};

/** Why a transport ends a device's connection. It travels to the client with the close. */
export type NexxusDeviceDisconnectReason = 'logged_out' | 'token_expired' | 'service_restart' | 'evicted';

/** What a verified device token proves about the connection presenting it. */
export type NexxusVolatileDeviceIdentity = {
  deviceId: string;
  appId: string;
  /** The token's `exp`, in UNIX seconds. The connection may not outlive it. */
  expiresAt: number;
};

/**
 * What a registering connection's token proves, the connections its device had
 * when it was read, and how many its application lets it hold open at once.
 */
export type NexxusVolatileDeviceRegistration = NexxusVolatileDeviceIdentity & {
  connections: Readonly<Record<string, NexxusDeviceConnection>>;
  /** The application's `connections.maxPerDevice`. */
  maxConnections: number;
};

export abstract class NexxusVolatileTransportWorker<
  T extends NexxusVolatileTransportWorkerConfig,
  Ev extends NexxusBaseWorkerEvents = {},
  S extends NexxusVolatileTransportWorkerStats = NexxusVolatileTransportWorkerStats
> extends NexxusBaseTransportWorker<T, Ev, S> {

  protected static loggerLabel: Readonly<string> = 'NxxVolatileTransport';

  /**
   * Where the slot queue stands: not declared yet, declared, or lost with the
   * message-queue connection it was declared on, until `beforeResume` declares
   * it again.
   */
  private slotQueueState: 'undeclared' | 'declared' | 'lost' = 'undeclared';

  /**
   * Dead connections being torn down (see `tearDownDeadConnection`), as
   * `deviceId|connectionId`, so each is torn down once however many times it
   * is met meanwhile.
   */
  private readonly deadConnectionTeardowns = new Set<string>();

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  /**
   * True while the slot queue is lost: nothing reaches a device connected here,
   * so a new connection should be turned away until it is back.
   */
  protected get isSlotQueueLost(): boolean {
    return this.slotQueueState === 'lost';
  }

  /**
   * Volatile transports route per node: each worker instance consumes from its own
   * per-slot queue (e.g. `websockets-transport_3`) so the Transport Manager can
   * target the exact node holding a given live connection.
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

    this.slotQueueState = 'declared';

    NexxusVolatileTransportWorker.logger.info(
      `Picked slot ${slot} — consuming from ${this.queueName}`,
      NexxusVolatileTransportWorker.loggerLabel,
    );
  }

  /**
   * A volatile queue goes with the message-queue connection that declared it.
   * Until `beforeResume` declares it again, nothing reaches the devices
   * connected here: every connection is ended, which tears it down so nothing
   * is routed here, and new ones are turned away (see `isSlotQueueLost`).
   */
  protected onServiceDown(name: NexxusWorkerServiceName): void {
    if (name !== 'mq' || this.slotQueueState !== 'declared') {
      return;
    }

    this.slotQueueState = 'lost';

    NexxusVolatileTransportWorker.logger.warn(
      `Slot queue ${this.queueName} went with the message-queue connection; ending every connection until it is declared again`,
      NexxusVolatileTransportWorker.loggerLabel,
    );

    void this.disconnectAllDevices('service_restart').catch((err: Error) => {
      NexxusVolatileTransportWorker.logger.error(
        `Failed to end connections after losing slot queue ${this.queueName}: ${err.message}`,
        NexxusVolatileTransportWorker.loggerLabel,
      );
    });
  }

  /**
   * Declare the slot queue again, before consuming resumes from it. Since a
   * volatile queue goes with the connection that declared it, one that exists
   * now is another worker's, which took the slot meanwhile: that is fatal.
   *
   * Losing a service again while declaring isn't. It can fail the declaration,
   * or make the queue look taken; either way the reconnect brings this back
   * round.
   */
  protected async beforeResume(): Promise<void> {
    if (this.slotQueueState !== 'lost') {
      return;
    }

    let failure: string | null = null;

    try {
      if (await NexxusBaseWorker.messageQueue.queueExists(this.queueName)) {
        failure = 'it exists on the broker, so another worker took the slot meanwhile';
      } else {
        await NexxusBaseWorker.messageQueue.createVolatileQueue(this.queueName);
      }
    } catch (err) {
      failure = (err as Error).message;
    }

    if (failure === null) {
      this.slotQueueState = 'declared';

      NexxusVolatileTransportWorker.logger.info(
        `Declared slot queue ${this.queueName} again; taking connections`,
        NexxusVolatileTransportWorker.loggerLabel,
      );

      return;
    }

    if (!this.isAvailable) {
      return;
    }

    throw new FatalErrorException(`Can't get slot queue ${this.queueName} back: ${failure}`);
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
   * Shut down without leaving a connection routed to this node:
   *
   * 1. Stop taking new connections.
   * 2. Stop consuming. Messages already being delivered still reach their
   *    devices.
   * 3. End every connection with `service_restart`. Each one is torn down the
   *    usual way, while Redis is still up.
   * 4. Delete the per-slot queue while it is still ours, so the slot number
   *    becomes available to future workers. A broker that drops an exclusive
   *    queue with its connection usually beats us to it; deleting it anyway
   *    (safe if already gone) keeps brokers without that behaviour consistent.
   *    A lost one went with its connection, and a queue by that name now may
   *    be another worker's.
   * 5. The base shutdown: Hub, management server, then the service connections.
   */
  public async close(): Promise<void> {
    this.stopAcceptingConnections();
    await NexxusBaseWorker.messageQueue.stopConsuming();
    await this.disconnectAllDevices('service_restart');

    if (this.slotQueueState === 'declared') {
      try {
        await NexxusBaseWorker.messageQueue.deleteQueue(this.queueName);
      } catch (err) {
        NexxusVolatileTransportWorker.logger.error(
          `Failed to delete slot queue ${this.queueName} on shutdown: ${(err as Error).message}`,
          NexxusVolatileTransportWorker.loggerLabel,
        );
      }
    }

    await super.close();
  }

  /**
   * Verify a device token and return what it proves. CPU only — no Redis — so it
   * is cheap enough to run on every in-place access-token refresh.
   *
   * This and the methods built on it live on the volatile base because a
   * volatile transport is the only place a client presents a credential —
   * persistent transports register out-of-band through the API, and their
   * `unregisterConnection` is triggered by the push provider, so neither has a token
   * to check. Every volatile transport (websockets today, MQTT or SSE tomorrow)
   * inherits one implementation rather than each re-deriving what a valid device
   * is.
   *
   * The application is found by reading `appId` off the UNVERIFIED token — the
   * worker has no other context from a bare socket — which only selects the key
   * to verify against. A forged appId picks a different key and fails the
   * signature check.
   *
   * Throws `InvalidTokenException` / `TokenExpiredException` from core — the
   * subclass maps these onto its own protocol's error shape.
   */
  protected verifyDeviceToken(token: string): NexxusVolatileDeviceIdentity {
    const appId = NexxusToken.peekAppId(token);

    if (!appId) {
      throw new InvalidTokenException('Token does not name an application');
    }

    const app = NexxusBaseWorker.loadedApps.get(appId);

    if (!app) {
      throw new InvalidTokenException(`Token names an unknown application "${appId}"`);
    }

    // `deviceId` is a plain string, not `string | undefined`: verify() checks
    // the claim shape, so there is nothing left to re-check here.
    const { deviceId, exp } = NexxusToken.verify(app, token);

    return { deviceId, appId, expiresAt: exp };
  }

  /**
   * Verify the token a connection REGISTERS with, and return what it proves.
   *
   * Beyond the signature, Redis is checked for two things the token can't prove:
   * that the device's record still exists, and that its session is still alive.
   * A device that logged out keeps an access token that is valid until it
   * expires — refusing it here is what stops that device reconnecting and
   * registering again, on this node or any other.
   *
   * The device's connections come back too, from the same read: registering
   * looks for dead ones among them (see `tearDownDeadConnections`), and counts
   * them against the application's cap (see `evictConnectionsOverCap`).
   *
   * Throws as `verifyDeviceToken` does, plus `RedisKeyNotFoundException` when the
   * device's record is gone and `SessionEndedException` when its session is over.
   */
  protected async authenticateDevice(token: string): Promise<NexxusVolatileDeviceRegistration> {
    const identity = this.verifyDeviceToken(token);
    const device = await NexxusDevice.get(identity.deviceId);

    if (!device.hasActiveSession()) {
      throw new SessionEndedException('The session this token belongs to has ended.');
    }

    return {
      ...identity,
      connections: device.getConnections(),
      // Loaded: `verifyDeviceToken` refuses a token naming an application that isn't.
      maxConnections: NexxusBaseWorker.loadedApps.get(identity.appId)!.getMaxConnectionsPerDevice()
    };
  }

  /**
   * Verify a refreshed access token that a registered connection presents in
   * order to keep going, and return its expiry.
   *
   * No Redis. A logout drops the connection itself (`device_logout`), so there is
   * nothing a session lookup would add on every refresh. The token must name the
   * device AND application the connection registered as; otherwise refreshing
   * would be a way to become a different device mid-connection.
   */
  protected authenticateRefreshedToken(token: string, deviceId: string, appId: string): number {
    const identity = this.verifyDeviceToken(token);

    if (identity.deviceId !== deviceId || identity.appId !== appId) {
      throw new InvalidTokenException('Token names a different device than the one this connection registered as');
    }

    return identity.expiresAt;
  }

  /**
   * End every connection a device has on this node, telling each client why.
   *
   * Idempotent: a device with no connection here — already closed, or never on
   * this node — is left alone. Teardown (subscriptions, Redis state) must stay on
   * the subclass's ordinary disconnect path, so a connection ended here and one
   * the client closes itself are cleaned up exactly once, the same way.
   */
  protected abstract disconnectDevice(deviceId: string, reason: NexxusDeviceDisconnectReason): Promise<void>;

  /**
   * End one connection on this node, telling its client why: a registered
   * one, or one still registering, which can be evicted once its entry is
   * written. Teardown stays on the ordinary disconnect path, as with
   * `disconnectDevice`. A connection this node doesn't hold is left alone.
   */
  protected abstract disconnectConnection(deviceId: string, connectionId: string, reason: NexxusDeviceDisconnectReason): Promise<void>;

  /**
   * Stop taking new connections; the open ones stay up. `close()` calls this
   * first, so no connection can arrive after `disconnectAllDevices` has ended
   * the others.
   */
  protected abstract stopAcceptingConnections(): void;

  /**
   * End every connection on this node, telling each client why, and resolve
   * once each one has been torn down, through the same path as any other
   * disconnect (see `disconnectDevice`). A client that doesn't close its end in
   * time is cut off, and torn down all the same.
   */
  protected abstract disconnectAllDevices(reason: NexxusDeviceDisconnectReason): Promise<void>;

  protected async handleDeviceLogout(deviceIds: Array<string>): Promise<void> {
    for (const deviceId of deviceIds) {
      await this.disconnectDevice(deviceId, 'logged_out');
    }
  }

  /**
   * Close the connections another node evicted (see `evictConnectionsOverCap`).
   * That node tore them down already.
   */
  protected async handleConnectionEvicted(connections: Array<NexxusTransportRecipient>): Promise<void> {
    for (const { deviceId, connectionId } of connections) {
      await this.disconnectConnection(deviceId, connectionId, 'evicted');
    }
  }

  /**
   * Called by the subclass once a connection's device is established (see
   * `authenticateDevice`). Opens the connection in Redis, on this node's queue,
   * with no subscriptions.
   *
   * The session is checked again as the connection opens: `authenticateDevice`
   * saw it alive, but a logout can end it in between. Throws
   * `SessionEndedException` when it has.
   */
  protected async registerConnection(deviceId: string, connectionId: string): Promise<void> {
    if (!await NexxusDevice.openConnection(deviceId, connectionId, { transport: this.queueName, type: 'volatile' })) {
      throw new SessionEndedException('The session this token belongs to has ended.');
    }
  }

  /**
   * Called by the subclass when a connection ends (whatever that means in its
   * protocol). Tears it down in Redis: its routes, then its entry. The device's
   * other connections are left as they are.
   */
  protected async unregisterConnection(deviceId: string, connectionId: string): Promise<void> {
    if (!await NexxusDevice.closeConnection(deviceId, connectionId)) {
      NexxusVolatileTransportWorker.logger.debug(
        `Connection "${connectionId}" of device "${deviceId}" was already torn down, by a logout or an eviction most likely`,
        { deviceId, connectionId },
        NexxusVolatileTransportWorker.loggerLabel
      );
    }
  }

  /**
   * Whether this node holds the connection: registered, or registering. A
   * subclass counts a registering connection as held from before its entry is
   * written to Redis, or a registration of the same device running alongside
   * could find that entry, not held, and tear it down as dead.
   */
  protected abstract holdsConnection(connectionId: string): boolean;

  /**
   * Called by the subclass while a connection registers, with the id of the
   * connection its client says it lost: one that closed without the client
   * asking. Tears that connection down, wherever it is, before the new one
   * opens. Only the device's own connections can be named; one that is gone
   * already is left as it is, and so is one this node still holds, which its
   * own teardown ends.
   *
   * A failure is logged, not thrown: the registration goes ahead, and the
   * connection is still ended by logout, or as dead by its node.
   */
  protected async releaseLostConnection(deviceId: string, connectionId: string): Promise<void> {
    if (this.holdsConnection(connectionId)) {
      NexxusVolatileTransportWorker.logger.debug(
        `Connection "${connectionId}" of device "${deviceId}", which its client lost, is still held here; left to its own teardown`,
        { deviceId, connectionId },
        NexxusVolatileTransportWorker.loggerLabel
      );

      return;
    }

    try {
      if (await NexxusDevice.closeConnection(deviceId, connectionId)) {
        NexxusVolatileTransportWorker.logger.info(
          `Tore down connection "${connectionId}" of device "${deviceId}", which its client lost`,
          { deviceId, connectionId },
          NexxusVolatileTransportWorker.loggerLabel
        );
      }
    } catch (err) {
      NexxusVolatileTransportWorker.logger.warn(
        `Could not tear down connection "${connectionId}" of device "${deviceId}", which its client lost: ${(err as Error).message}`,
        { deviceId, connectionId },
        NexxusVolatileTransportWorker.loggerLabel
      );
    }
  }

  /**
   * Called by the subclass while a connection registers, with the connections
   * its device had: tears down, as dead, those on this node's queue that this
   * node doesn't hold (see `tearDownDeadConnection`).
   */
  protected tearDownDeadConnections(deviceId: string, connections: Readonly<Record<string, NexxusDeviceConnection>>): void {
    for (const [ connectionId, { transport } ] of Object.entries(connections)) {
      if (transport === this.queueName) {
        this.tearDownDeadConnection(deviceId, connectionId);
      }
    }
  }

  /**
   * A connection on this node's queue that this node doesn't hold is dead. One
   * process consumes a slot queue at a time, and it holds every connection
   * registered on it, so such a connection belonged to a process that held the
   * slot before, or its own teardown failed.
   *
   * Torn down in the background, once however many times it is met meanwhile.
   * One this node holds is left alone. A failure is logged: the connection is
   * met again, and torn down then, the next time something names it.
   */
  protected tearDownDeadConnection(deviceId: string, connectionId: string): void {
    const key = `${deviceId}|${connectionId}`;

    if (this.holdsConnection(connectionId) || this.deadConnectionTeardowns.has(key)) {
      return;
    }

    this.deadConnectionTeardowns.add(key);

    void NexxusDevice.closeConnection(deviceId, connectionId)
      .then(tornDown => {
        if (tornDown) {
          NexxusVolatileTransportWorker.logger.info(
            `Tore down connection "${connectionId}" of device "${deviceId}": it is on this node's queue, but this node doesn't hold it`,
            { deviceId, connectionId },
            NexxusVolatileTransportWorker.loggerLabel
          );
        }
      })
      .catch((err: Error) => {
        NexxusVolatileTransportWorker.logger.warn(
          `Could not tear down dead connection "${connectionId}" of device "${deviceId}": ${err.message}`,
          { deviceId, connectionId },
          NexxusVolatileTransportWorker.loggerLabel
        );
      })
      .finally(() => {
        this.deadConnectionTeardowns.delete(key);
      });
  }

  /**
   * Called by the subclass once a connection has registered, with what its
   * registration read, the new connection's id, and the connection its client
   * said it lost, if any: keeps the device within its application's cap
   * (`maxConnections`) by evicting its oldest connections, wherever they are.
   * Each one is torn down in Redis, then closed with `evicted`: here directly,
   * on another node through a `connection_evicted` message to the queue it is
   * on. The new connection is never evicted.
   *
   * The new connection counts, and so do the device's other volatile
   * connections as the registration read them, except those being torn down,
   * dead ones (see `tearDownDeadConnection`), and the one the client lost,
   * which `releaseLostConnection` tore down unless this node still holds it.
   * Push connections neither count nor get evicted.
   *
   * A soft cap: two registrations of a device at the same moment each count
   * without the other, so the device can be over its cap until its next
   * registration.
   *
   * Runs in the background. A failure is logged, and leaves the connection
   * open until its device registers again.
   */
  protected evictConnectionsOverCap(
    registration: NexxusVolatileDeviceRegistration,
    connectionId: string,
    lostConnectionId?: string
  ): void {
    const { deviceId, connections, maxConnections } = registration;
    const counted = Object.entries(connections).filter(([ id, connection ]) =>
      id !== connectionId && this.countsTowardCap(id, connection, lostConnectionId)
    );
    // The new connection, besides those counted.
    const excess = counted.length + 1 - maxConnections;

    if (excess <= 0) {
      return;
    }

    const evicted = counted.sort(NexxusVolatileTransportWorker.oldestFirst).slice(0, excess);

    NexxusVolatileTransportWorker.logger.info(
      `Device "${deviceId}" is over its cap of ${maxConnections} connection(s); evicting the ${excess} oldest`,
      { deviceId, maxConnections, evicted: evicted.map(([ id ]) => id) },
      NexxusVolatileTransportWorker.loggerLabel
    );

    void this.evictConnections(deviceId, evicted).catch((err: Error) => {
      NexxusVolatileTransportWorker.logger.warn(
        `Could not evict the connections of device "${deviceId}" over its cap: ${err.message}`,
        { deviceId },
        NexxusVolatileTransportWorker.loggerLabel
      );
    });
  }

  /**
   * Whether a connection a registration read counts toward its device's cap
   * (see `evictConnectionsOverCap`).
   */
  private countsTowardCap(connectionId: string, connection: NexxusDeviceConnection, lostConnectionId?: string): boolean {
    if (connection.type !== 'volatile' || connection.closing) {
      return false;
    }

    if (this.holdsConnection(connectionId)) {
      return true;
    }

    // Not held: dead if on this node's queue, released if the client lost it.
    return connection.transport !== this.queueName && connectionId !== lostConnectionId;
  }

  /** Orders connections by when they opened, oldest first; by id between two opened at once. */
  private static oldestFirst(
    [ idA, a ]: [ string, NexxusDeviceConnection ],
    [ idB, b ]: [ string, NexxusDeviceConnection ]
  ): number {
    if (a.connectedAt !== b.connectedAt) {
      return a.connectedAt < b.connectedAt ? -1 : 1;
    }

    return idA < idB ? -1 : 1;
  }

  /**
   * Tear each connection down, then close it: one on this node directly, the
   * others with one `connection_evicted` message per queue they are on. Only
   * the connections this tore down are closed. One torn down already was
   * closed, or is being closed, by whatever tore it down.
   */
  private async evictConnections(deviceId: string, evicted: Array<[ string, NexxusDeviceConnection ]>): Promise<void> {
    const elsewhere = new Map<string, Array<NexxusTransportRecipient>>();

    await Promise.all(evicted.map(async ([ connectionId, { transport } ]) => {
      try {
        if (!await NexxusDevice.closeConnection(deviceId, connectionId)) {
          return;
        }
      } catch (err) {
        NexxusVolatileTransportWorker.logger.warn(
          `Could not evict connection "${connectionId}" of device "${deviceId}": ${(err as Error).message}`,
          { deviceId, connectionId },
          NexxusVolatileTransportWorker.loggerLabel
        );

        return;
      }

      if (transport === this.queueName) {
        await this.disconnectConnection(deviceId, connectionId, 'evicted');

        return;
      }

      const queued = elsewhere.get(transport) ?? [];

      queued.push({ deviceId, connectionId });
      elsewhere.set(transport, queued);
    }));

    for (const [ transport, connections ] of elsewhere) {
      await this.publish(transport, { event: 'connection_evicted', connections });
    }
  }
}
