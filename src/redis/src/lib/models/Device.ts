import { NexxusRedis } from '../Redis';
import {
  RedisCommandErrorException,
  RedisKeyNotFoundException,
  RedisDeviceInvalidParamsException,
  RedisDeviceNotConnectedException
} from '../Exceptions'
import { NexxusRedisSubscription } from './Subscription';
import { NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';

import crypto from 'crypto';

/**
 * A device: one installation of a client application. How it is reached lives
 * in its connections (see `NexxusDeviceConnection`), which are kept off these
 * props, like its session.
 */
export interface NexxusDeviceProps {
  id: string;
  appId: string;
  name: string;
  userId?: string;
  /** When a connection last opened, or a sign-in last reused the device. Undefined until one of them happens. */
  lastSeen?: Date;
}

type NexxusDeviceConstructorProps = Omit<NexxusDeviceProps, 'lastSeen'> & {
  lastSeen?: string;
}

type NexxusDeviceUpdateProps = Partial<Pick<NexxusDeviceProps, 'name' | 'lastSeen'>>;

type NexxusDeviceRedisProps = Omit<NexxusDeviceProps, 'lastSeen'> & {
  lastSeen?: string;
  session?: NexxusDeviceSession;
  connections?: Record<string, NexxusDeviceConnection>;
}

/** How a connection reaches its device: held open by a transport, or through a push service. */
export type NexxusDeviceConnectionType = 'volatile' | 'persistent';

/**
 * One connection of a device, stored under `$.connections` on the device
 * document, keyed by the connection's id. Each connection writes only its own
 * entry.
 */
export type NexxusDeviceConnection = {
  /** The queue the connection is reached through. */
  transport: string;
  type: NexxusDeviceConnectionType;
  /** Keys of the channels the connection subscribes to. */
  subscriptions: string[];
  /** When the connection opened, as an ISO string. */
  connectedAt: string;
  /** Set when its teardown starts. From then on it takes no new subscriptions. */
  closing?: true;
};

/**
 * A device's refresh session: one installation's right to keep obtaining access
 * tokens, stored at `$.session` on the device document.
 *
 * Hashes only — the secret the client holds is never stored, so a dump of Redis
 * yields nothing that can be presented. Timestamps are UNIX seconds.
 *
 * `expiresAt` is ABSOLUTE: fixed when the session starts and carried unchanged
 * through every rotation. Resetting it on rotation would turn it into an idle
 * timeout — a device refreshing hourly would never have to sign in again.
 */
export type NexxusDeviceSession = {
  /** SHA-256 (hex) of the secret that is currently valid. */
  hash: string;
  /** Hash of the secret the current one replaced — what replay detection compares against. */
  prevHash?: string;
  /** When the last rotation happened; the reuse interval for `prevHash` counts from here. */
  rotatedAt?: number;
  expiresAt: number;
};

/** Outcome of `NexxusDevice.rotateSession`. */
export type NexxusSessionRotation = 'rotated' | 'replayed' | 'expired' | 'invalid';

/** Outcome of `NexxusDevice.revokeSession`. */
export type NexxusSessionRevocation = 'revoked' | 'invalid';

/** How a presented secret relates to the stored session. */
type NexxusSessionMatch = 'none' | 'unknown' | 'current' | 'previous' | 'replayed' | 'expired';

export class NexxusDevice {
  /**
   * How long after a rotation the previous secret still rotates, in seconds.
   * Covers a refresh whose response was lost on a flaky network: the client
   * retries with the secret the server already replaced. After this, presenting
   * it is treated as a replay.
   */
  private static readonly DEFAULT_REUSE_INTERVAL_SECONDS = 10;

  /**
   * Compare-and-set attempts before a rotation gives up. A failed swap means
   * another rotation landed between this one's read and its write; losing that
   * race several times in a row isn't contention, it's a bug.
   */
  private static readonly MAX_ROTATION_ATTEMPTS = 3;

  /**
   * What a connection id may contain. Ids end up in subscription members,
   * whose parts are separated by `|`, and inside quotes in JSON paths.
   */
  private static readonly CONNECTION_ID_PATTERN = /^[A-Za-z0-9_:-]{1,256}$/;

  private data: NexxusDeviceProps;

  /**
   * The connections found when this device was loaded, by id. Kept off `data`
   * like the session: `data` is what API responses are built from.
   */
  private connections: Record<string, NexxusDeviceConnection> = {};

  /**
   * `expiresAt` of the session found when this device was loaded — and only
   * that. Kept off `data` on purpose: `data` is what `getValue()` hands to API
   * responses, and nothing about a session belongs in one.
   */
  private sessionExpiresAt?: number;

  constructor(props: NexxusDeviceConstructorProps) {
    this.data = {
      id: props.id || crypto.randomUUID(),
      appId: props.appId,
      name: props.name || 'Unnamed Device',
      userId: props.userId,
      lastSeen: props.lastSeen ? new Date(props.lastSeen) : undefined
    };

    if (!props.appId) {
      throw new RedisDeviceInvalidParamsException('appId is required to create a Device instance');
    }
  }

  public getValue(): NexxusDeviceProps {
    return this.data;
  }

  /**
   * Whether this device held an unexpired session when it was loaded.
   *
   * Answered from the document `get()` already read, so a caller that loads the
   * device anyway — the transport's register handshake — gets it without a second
   * request. A device constructed in memory rather than loaded has none.
   */
  public hasActiveSession(): boolean {
    return this.sessionExpiresAt !== undefined && NexxusDevice.nowSeconds() < this.sessionExpiresAt;
  }

  /**
   * The device's connections when it was loaded, by id. A device constructed in
   * memory rather than loaded has none.
   */
  public getConnections(): Readonly<Record<string, NexxusDeviceConnection>> {
    return this.connections;
  }

  public getKey(): string {
    return NexxusDevice.getKey(this.data.id);
  }

  public static getKey(id: string): string {
    return `${NEXXUS_PREFIX_LC}:device:${id}`;
  }

  public static async get(id : string): Promise<NexxusDevice> {
    const res = await NexxusRedis.instance.getClient().json.get(NexxusDevice.getKey(id)) as NexxusDeviceRedisProps | null;

    if (!res) {
      throw new RedisKeyNotFoundException(`Device with id "${id}" not found`);
    }

    const device = new NexxusDevice(res);

    // The constructor copies known fields only, so `session` and `connections`
    // never reach `data`. They are kept aside for `hasActiveSession()` and
    // `getConnections()`.
    device.sessionExpiresAt = res.session?.expiresAt;
    device.connections = res.connections ?? {};

    return device;
  }

  /**
   * Whether each device exists, by id. One single-key `EXISTS` per device, all
   * sent at once: a cluster refuses a command whose keys live on different
   * nodes, and device keys are spread across all of them.
   */
  public static async exists(ids: string[]): Promise<Map<string, boolean>> {
    const client = NexxusRedis.instance.getClient();
    const found = await Promise.all(ids.map(id => client.exists(NexxusDevice.getKey(id))));

    return new Map(ids.map((id, i) => [ id, found[i] === 1 ]));
  }

  public static async update(id: string, updates: NexxusDeviceUpdateProps): Promise<void> {
    const redis = NexxusRedis.instance.getClient();
    const key = this.getKey(id);
    const jsonUpdates : Array<{ key: string, path: string, value: any }> = [];

    for (const [field, value] of Object.entries(updates)) {
      // Skipped, so a caller can pass optional fields it has no value for.
      if (value === undefined) {
        continue;
      }

      const typedField = field as keyof NexxusDeviceUpdateProps;

      switch (typedField) {
        case 'lastSeen':
          if (!(value instanceof Date)) {
            throw new RedisDeviceInvalidParamsException(`Invalid value for lastSeen: expected Date, got ${typeof value}`);
          }

          jsonUpdates.push({ key, path: `$.${field}`, value: (value as Date).toISOString() });

          break;
        case 'name':
          if (typeof value !== 'string') {
            throw new RedisDeviceInvalidParamsException(`Invalid value for ${field}: expected string, got ${typeof value}`);
          }

          jsonUpdates.push({ key, path: `$.${field}`, value });

          break;
        default:
          throw new RedisDeviceInvalidParamsException(`Unknown field "${field}"`);
      }
    }

    if (jsonUpdates.length === 0) {
      return;
    }

    NexxusRedis.logger.debug(`Updating device with id "${id}"`, { id, updates: jsonUpdates }, 'NxxRedis');

    const res = await redis.json.mSet(jsonUpdates);

    if (!res) {
      throw new RedisCommandErrorException(`Failed to update device with id "${id}"`);
    }

    NexxusRedis.logger.debug(`Updated device with id "${id}"`);
  }

  /**
   * Start a session, replacing any the device already had — along with its whole
   * rotation chain. Called wherever a session is issued: sign-up, sign-in, device
   * registration.
   *
   * `expiresAt` is the absolute deadline in UNIX seconds; rotation never moves it.
   */
  public static async setSession(id: string, secret: string, expiresAt: number): Promise<void> {
    const session: NexxusDeviceSession = { hash: NexxusDevice.hashSecret(secret), expiresAt };

    try {
      await NexxusRedis.instance.getClient().json.set(NexxusDevice.getKey(id), '$.session', session);
    } catch (e) {
      // RedisJSON refuses to create a document from a nested path, which is how
      // a missing device surfaces here.
      throw new RedisCommandErrorException(`Failed to start a session on device "${id}": ${(e as Error).message}`);
    }
  }

  /**
   * Exchange the presented secret for a new one — the refresh.
   *
   * - `rotated`: the secret was current, or the previous one within the reuse
   *   interval. `newSecret` is now current; `expiresAt` is unchanged.
   * - `replayed`: the previous secret, after the reuse interval. The client, or
   *   someone holding a copy, has already moved past it, so the session is ended
   *   and both have to sign in again.
   * - `expired`: past `expiresAt`. The session is ended.
   * - `invalid`: the secret matches nothing, or there is no session. Nothing
   *   changes — acting on an unmatched secret would let anyone who knows a device
   *   id (they are not secret) end that device's session.
   *
   * Throws `RedisKeyNotFoundException` when the device does not exist.
   */
  public static async rotateSession(
    id: string,
    presentedSecret: string,
    newSecret: string,
    options: { reuseIntervalSeconds?: number } = {}
  ): Promise<NexxusSessionRotation> {
    const presentedHash = NexxusDevice.hashSecret(presentedSecret);
    const newHash = NexxusDevice.hashSecret(newSecret);
    const reuseInterval = options.reuseIntervalSeconds ?? NexxusDevice.DEFAULT_REUSE_INTERVAL_SECONDS;
    const now = NexxusDevice.nowSeconds();

    for (let attempt = 0; attempt < NexxusDevice.MAX_ROTATION_ATTEMPTS; attempt++) {
      const session = await NexxusDevice.readSession(id);
      const match = NexxusDevice.classifySecret(session, presentedHash, now, reuseInterval);

      if (session && (match === 'current' || match === 'previous')) {
        const swapped = await NexxusDevice.swapSession(id, session.hash, {
          hash: newHash,
          prevHash: session.hash,
          rotatedAt: now,
          expiresAt: session.expiresAt
        });

        if (swapped) {
          return 'rotated';
        }

        // Another rotation landed between the read and the swap. Decide again
        // on what is stored now.
        continue;
      }

      if (match === 'replayed' || match === 'expired') {
        await NexxusDevice.clearSession(id);

        return match;
      }

      return 'invalid';
    }

    throw new RedisCommandErrorException(
      `Could not rotate the session of device "${id}": lost the compare-and-set ${NexxusDevice.MAX_ROTATION_ATTEMPTS} times in a row`
    );
  }

  /**
   * End the session the presented secret belongs to — logout.
   *
   * Any secret the session recognises ends it: current, previous (inside or past
   * the reuse interval), even an expired one. Ending is what a replay would cause
   * anyway. An unmatched secret changes nothing, for the same reason as in
   * `rotateSession`.
   *
   * Throws `RedisKeyNotFoundException` when the device does not exist.
   */
  public static async revokeSession(id: string, presentedSecret: string): Promise<NexxusSessionRevocation> {
    const session = await NexxusDevice.readSession(id);
    const match = NexxusDevice.classifySecret(
      session,
      NexxusDevice.hashSecret(presentedSecret),
      NexxusDevice.nowSeconds(),
      NexxusDevice.DEFAULT_REUSE_INTERVAL_SECONDS
    );

    if (match === 'none' || match === 'unknown') {
      return 'invalid';
    }

    await NexxusDevice.clearSession(id);

    return 'revoked';
  }

  /**
   * End a device's session unconditionally. Idempotent: a device with no session,
   * or no device at all, is left as it is.
   */
  public static async clearSession(id: string): Promise<void> {
    await NexxusRedis.instance.getClient().json.del(NexxusDevice.getKey(id), { path: '$.session' });
  }

  /**
   * The stored session, or `null` when the device has none. Throws when the device
   * itself does not exist. A JSONPath read returns an ARRAY of matches, hence `[0]`.
   */
  private static async readSession(id: string): Promise<NexxusDeviceSession | null> {
    const res = await NexxusRedis.instance.getClient().json.get(
      NexxusDevice.getKey(id),
      { path: '$.session' }
    ) as NexxusDeviceSession[] | null;

    if (res === null) {
      throw new RedisKeyNotFoundException(`Device with id "${id}" not found`);
    }

    return res[0] ?? null;
  }

  /**
   * Run the compare-and-set. `true` when swapped, `false` when the stored hash has
   * moved on since the caller read it.
   */
  private static async swapSession(id: string, expectedHash: string, next: NexxusDeviceSession): Promise<boolean> {
    const result = await NexxusRedis.instance.scripts.run('device-session-cas', {
      keys: [ NexxusDevice.getKey(id) ],
      args: [ expectedHash, JSON.stringify(next) ]
    });

    if (result === -1) {
      throw new RedisKeyNotFoundException(`Device with id "${id}" not found`);
    }

    return result === 1;
  }

  /**
   * How a presented secret relates to the stored session. Pure: every decision
   * the session methods make is taken here, from state already read.
   *
   * Expiry is looked at only after a match, so an unmatched secret learns nothing
   * about the session and changes nothing, whatever state it is in.
   */
  private static classifySecret(
    session: NexxusDeviceSession | null,
    presentedHash: string,
    now: number,
    reuseIntervalSeconds: number
  ): NexxusSessionMatch {
    if (!session) {
      return 'none';
    }

    const isCurrent = NexxusDevice.hashesEqual(session.hash, presentedHash);
    const isPrevious = !isCurrent && NexxusDevice.hashesEqual(session.prevHash, presentedHash);

    if (!isCurrent && !isPrevious) {
      return 'unknown';
    }

    if (now >= session.expiresAt) {
      return 'expired';
    }

    if (isCurrent) {
      return 'current';
    }

    return now - (session.rotatedAt ?? 0) <= reuseIntervalSeconds ? 'previous' : 'replayed';
  }

  /** Constant-time comparison of two hex hashes; `false` when the stored one is absent. */
  private static hashesEqual(stored: string | undefined, presented: string): boolean {
    if (stored === undefined || stored.length !== presented.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(presented));
  }

  /**
   * SHA-256, not bcrypt. bcrypt exists to slow down guessing low-entropy
   * passwords; a refresh secret is a long random value that can't be guessed, so
   * bcrypt would only add CPU to every refresh.
   */
  private static hashSecret(secret: string): string {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }

  private static nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** Whether `id` can name a connection: 1 to 256 letters, digits, `_`, `:` or `-`. */
  public static isValidConnectionId(id: string): boolean {
    return NexxusDevice.CONNECTION_ID_PATTERN.test(id);
  }

  /**
   * Open a connection on a device, reached through `transport`: add its entry,
   * with no subscriptions, and record `lastSeen`. Only while the device's
   * session is active: one that a logout ended after the caller checked it
   * leaves the device as it is. An entry already under this id is kept as it
   * is.
   *
   * Returns whether the connection is open. Throws `RedisKeyNotFoundException`
   * when the device does not exist.
   */
  public static async openConnection(
    deviceId: string,
    connectionId: string,
    connection: Pick<NexxusDeviceConnection, 'transport' | 'type'>
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const entry: NexxusDeviceConnection = {
      transport: connection.transport,
      type: connection.type,
      subscriptions: [],
      connectedAt: now
    };
    const result = await NexxusRedis.instance.scripts.run('connection-open', {
      keys: [ NexxusDevice.getKey(deviceId) ],
      args: [
        NexxusDevice.connectionPath(connectionId),
        JSON.stringify(entry),
        String(NexxusDevice.nowSeconds()),
        JSON.stringify(now)
      ]
    });

    if (result === -1) {
      throw new RedisKeyNotFoundException(`Device with id "${deviceId}" not found`);
    }

    return result === 1;
  }

  /**
   * Tear a connection down: mark it closing, remove the routes of every channel
   * it lists, then delete its entry. Only this connection's routes go; the
   * device's other connections keep theirs, on the same transport or not.
   *
   * Safe to repeat, and to run from several places at once: a run finishes
   * what an earlier one left, and each scope counter is decremented once.
   * Returns whether there was a connection to tear down.
   */
  public static async closeConnection(deviceId: string, connectionId: string): Promise<boolean> {
    const key = NexxusDevice.getKey(deviceId);
    const path = NexxusDevice.connectionPath(connectionId);
    const raw = await NexxusRedis.instance.scripts.run('connection-close', { keys: [ key ], args: [ path ] });

    if (raw === null) {
      return false;
    }

    const [ entry ] = JSON.parse(raw) as [ NexxusDeviceConnection ];

    // Routes before the entry: a teardown cut short leaves an entry for the
    // next one to finish, never a route that nothing lists.
    await Promise.all(entry.subscriptions.map(channelKey =>
      NexxusRedisSubscription.fromKey(channelKey).removeConnection(deviceId, entry.transport, connectionId)
    ));

    await NexxusRedis.instance.getClient().json.del(key, { path });

    return true;
  }

  /**
   * Subscribe one connection of a device to a channel: list the channel on the
   * connection's entry, then add its route. Subscribing again is harmless.
   *
   * A connection that is closing, or gone, takes no subscription. A teardown
   * that starts while this runs can remove the connection's routes before the
   * one here is added, so the connection is checked again afterwards, and the
   * route removed if the connection is closing by then.
   *
   * Throws `RedisDeviceNotConnectedException` when the connection is not open,
   * and `RedisKeyNotFoundException` when the device does not exist.
   */
  public static async addSubscription(
    deviceId: string,
    connectionId: string,
    subscription: NexxusRedisSubscription
  ): Promise<void> {
    const path = NexxusDevice.connectionPath(connectionId);
    const transport = await NexxusRedis.instance.scripts.run('connection-subscribe', {
      keys: [ NexxusDevice.getKey(deviceId) ],
      args: [ path, JSON.stringify(subscription.getKey()) ]
    });

    if (transport === -1) {
      throw new RedisKeyNotFoundException(`Device with id "${deviceId}" not found`);
    }

    if (transport === -2) {
      throw new RedisDeviceNotConnectedException(`Connection "${connectionId}" of device "${deviceId}" is not open`);
    }

    await subscription.addConnection(deviceId, transport, connectionId);

    if (!await NexxusDevice.isConnectionOpen(deviceId, path)) {
      await subscription.removeConnection(deviceId, transport, connectionId);

      throw new RedisDeviceNotConnectedException(
        `Connection "${connectionId}" of device "${deviceId}" closed while subscribing`
      );
    }
  }

  /**
   * Unsubscribe one connection of a device from a channel: remove the route,
   * then take the channel off the connection's entry.
   *
   * Returns whether the connection was subscribed. Throws
   * `RedisDeviceNotConnectedException` when the connection doesn't exist, and
   * `RedisKeyNotFoundException` when the device does not exist.
   */
  public static async removeSubscription(
    deviceId: string,
    connectionId: string,
    subscription: NexxusRedisSubscription
  ): Promise<boolean> {
    const path = NexxusDevice.connectionPath(connectionId);
    const connection = await NexxusDevice.readConnection(deviceId, path);

    if (!connection) {
      throw new RedisDeviceNotConnectedException(`Connection "${connectionId}" of device "${deviceId}" is not open`);
    }

    // Route before listing: a failure in between leaves a channel listed with
    // no route, which is harmless and goes with the connection, rather than a
    // route that nothing lists.
    const routed = await subscription.removeConnection(deviceId, connection.transport, connectionId);
    const listed = await NexxusRedis.instance.scripts.run('connection-unsubscribe', {
      keys: [ NexxusDevice.getKey(deviceId) ],
      args: [ path, JSON.stringify(subscription.getKey()) ]
    });

    return routed || listed === 1;
  }

  /**
   * The JSON path of a connection's entry. Throws on an id that isn't valid,
   * so no other id reaches a path or a route.
   */
  private static connectionPath(connectionId: string): string {
    if (!NexxusDevice.isValidConnectionId(connectionId)) {
      throw new RedisDeviceInvalidParamsException('A connection id is 1 to 256 letters, digits, "_", ":" or "-"');
    }

    return `$.connections['${connectionId}']`;
  }

  /**
   * The entry at `path`, or `null` when the device has no such connection.
   * Throws when the device itself does not exist.
   */
  private static async readConnection(deviceId: string, path: string): Promise<NexxusDeviceConnection | null> {
    const res = await NexxusRedis.instance.getClient().json.get(
      NexxusDevice.getKey(deviceId),
      { path }
    ) as NexxusDeviceConnection[] | null;

    if (res === null) {
      throw new RedisKeyNotFoundException(`Device with id "${deviceId}" not found`);
    }

    return res[0] ?? null;
  }

  /** Whether the entry at `path` exists and isn't closing. A device that doesn't exist has none. */
  private static async isConnectionOpen(deviceId: string, path: string): Promise<boolean> {
    const res = await NexxusRedis.instance.getClient().json.get(
      NexxusDevice.getKey(deviceId),
      { path }
    ) as NexxusDeviceConnection[] | null;

    return res?.[0] !== undefined && !res[0].closing;
  }

  /**
   * Create the device, with no connections. ONLY create: this writes the whole
   * document at `$` from `data`, and `data` never carries the session or the
   * connections, so overwriting an existing device this way would silently
   * erase them. `NX` makes that impossible rather than merely discouraged.
   * Change an existing device through `update()`, the session methods and the
   * connection methods, which write single paths.
   */
  public async save(): Promise<void> {
    const res = await NexxusRedis.instance.getClient().json.set(this.getKey(), '$', {
      ...this.data,
      ...(this.data.lastSeen ? { lastSeen: this.data.lastSeen.toISOString() } : {}),
      connections: {}
    }, { condition: 'NX' });

    if (!res) {
      throw new RedisCommandErrorException(
        `Device with id "${this.data.id}" already exists — save() only creates; use update() to change it`
      );
    }

    NexxusRedis.logger.debug(`Saved device with id "${this.data.id}"`);
  }
}
