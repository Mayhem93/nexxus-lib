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

type NexxusDeviceTransportType = 'volatile' | 'persistent' | 'unknown';

export interface NexxusDeviceProps {
  id: string;
  appId: string;
  name: string;
  userId?: string;
  /**
   * "volatile" - devices are connected to transports that are connection-oriented, their subscriptions only exist while they
   * are connected
   *
   * "persistent" - devices are connected to transports that are not connection-oriented (eg: Apple Push Notifications), their
   * subscriptions persist until the 3rd party service confirms that the subscription is removed, or the device is manually
   * removed from the system.
   *
   * "unknown" - device type is not known until it registers with a transport, at which point it will be classified as either
   * "volatile" or "persistent" based on the transport type
   */
  type: NexxusDeviceTransportType;
  /**
   * Current reachability state. Undefined for devices that have never been registered with a transport
   * (e.g. freshly created via the API) and for persistent devices where the concept doesn't apply.
   * Once set, this field is never cleared — only overwritten on subsequent state transitions.
   */
  status?: 'online' | 'offline' | 'unknown';
  /**
   * The transport this device is associated with — for volatile transports this is the per-node queue
   * the device's live connection is on; for persistent transports this is the shared queue used to
   * reach the device via its 3rd-party push service. Once a device registers with a transport, this
   * field is set permanently; subsequent registrations can overwrite it (e.g. reconnect to a different
   * volatile worker node), but it is never cleared back to undefined.
   */
  transport?: string | null;
  /**
   * Volatile-only: timestamp of the last time the device was seen online. Undefined for devices that
   * have never connected and for persistent devices (where it has no meaning). Once set, never cleared.
   */
  lastSeen?: Date;
  subscriptions: NexxusRedisSubscription[];
}

type NexxusDeviceConstructorProps = Omit<NexxusDeviceProps, 'lastSeen' |'subscriptions' | 'type'> & {
  type?: NexxusDeviceTransportType;
  lastSeen?: string;
  subscriptions: NexxusRedisSubscription[] | [];
}

type NexxusDeviceUpdateProps = Omit<Partial<NexxusDeviceProps>, 'id' | 'appId' | 'subscriptions'>;

type NexxusDeviceRedisProps = Omit<NexxusDeviceProps, 'lastSeen' | 'subscriptions'> & {
  lastSeen?: string;
  subscriptions: string[];
  session?: NexxusDeviceSession;
}

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

/**
 * Swap `$.session` only if its `hash` is still the one the caller read.
 *
 * The rotation DECISION is made in TypeScript, from state already read; this
 * script only makes the write conditional, so two refreshes racing on the same
 * secret can't both swap. Keeping it this small is what keeps the decision
 * unit-testable.
 *
 * Touches one key, passed as KEYS[1], so it is single-slot and runs unchanged on
 * a cluster.
 *
 * Returns 1 when swapped, 0 when the stored hash differs (including when there is
 * no session at all), -1 when the device does not exist.
 */
export const NEXXUS_DEVICE_SESSION_CAS_SCRIPT = `
local raw = redis.call('JSON.GET', KEYS[1], '$.session.hash')
if not raw then return -1 end
local found = cjson.decode(raw)
if found[1] ~= ARGV[1] then return 0 end
redis.call('JSON.SET', KEYS[1], '$.session', ARGV[2])
return 1
`;

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

  private data: NexxusDeviceProps;

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
      type: props.type || 'unknown',
      status: props.status,
      transport: props.transport,
      lastSeen: props.lastSeen ? new Date(props.lastSeen) : undefined,
      subscriptions: props.subscriptions || []
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

  public getKey(): string {
    return NexxusDevice.getKey(this.data.id);
  }

  public static getKey(id: string): string {
    return `${NEXXUS_PREFIX_LC}:device:${id}`;
  }

  public static async get(id : string, withSubscriptions: boolean = false): Promise<NexxusDevice> {
    const res = await NexxusRedis.instance.getClient().json.get(`${NEXXUS_PREFIX_LC}:device:${id}`) as NexxusDeviceRedisProps | null;

    if (!res) {
      throw new RedisKeyNotFoundException(`Device with id "${id}" not found`);
    }

    const device = new NexxusDevice({
      ...res,
      subscriptions: withSubscriptions ? await Promise.all(res.subscriptions.map(subKey => {
        const sub = NexxusRedisSubscription.fromKey(subKey);

        sub.setAppId(res.appId);

        return sub;
      })) : []
    });

    // The constructor copies known fields only, so `session` never reaches
    // `data`. Its expiry is kept aside for `hasActiveSession()`.
    device.sessionExpiresAt = res.session?.expiresAt;

    return device;
  }

  public static async update(id: string, updates: NexxusDeviceUpdateProps): Promise<void> {
    const redis = NexxusRedis.instance.getClient();
    const key = this.getKey(id);
    const jsonUpdates : Array<{ key: string, path: string, value: any }> = [];

    for (const [field, value] of Object.entries(updates)) {
      // Devices cannot have their fields cleared after being set — once a device is classified by a
      // transport, those fields stay set forever. Skip undefined values so callers can pass partial
      // updates that include optional fields without effect.
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
        case 'transport':
        case 'name':
        case 'type':
        case 'status':
          if (value !== null && typeof value !== 'string') {
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
    const result = await NexxusRedis.instance.getClient().eval(NEXXUS_DEVICE_SESSION_CAS_SCRIPT, {
      keys: [ NexxusDevice.getKey(id) ],
      arguments: [ expectedHash, JSON.stringify(next) ]
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

  public static async removeAllSubscriptions(deviceId: string): Promise<void> {
    const redis = NexxusRedis.instance.getClient();
    const device = await NexxusDevice.get(deviceId, true);
    const promises : Promise<boolean>[] = [];

    for (const subInstance of device.data.subscriptions) {
      if (device.data.transport) {
        promises.push(subInstance.removeDevice(deviceId, device.data.transport));
      } else {
        NexxusRedis.logger.warn(`Device with id "${deviceId}" is not connected to any transport, cannot remove subscriptions`);
      }
    }

    const result = await Promise.all(promises);
    const removedCount = result.filter(r => r).length;

    await redis.json.clear(`${NEXXUS_PREFIX_LC}:device:${deviceId}`, { path: '$.subscriptions' });

    NexxusRedis.logger.debug(`Removed ${removedCount} subscriptions from device with id "${deviceId}"`);
  }

  public async addSubscription(subscription: NexxusRedisSubscription): Promise<boolean> {
    if (!this.data.transport) {
      throw new RedisDeviceNotConnectedException(`Device with id "${this.data.id}" is not connected to any transport`);
    }

    const redis = NexxusRedis.instance.getClient();

    subscription.setAppId(this.data.appId);

    const index = await this.hasSubscription(subscription);

    if (index !== null) {
      NexxusRedis.logger.debug(`Subscription "${subscription.getKey()}" already exists on device with id "${this.data.id}"`);

      return false;
    }

    const res = await redis.json.arrAppend(
      `${NEXXUS_PREFIX_LC}:device:${this.data.id}`,
      '$.subscriptions',
      subscription.getKey()
    );

    if (res === null) {
      throw new RedisCommandErrorException(`Failed to add subscription to device with id "${this.data.id}"`);
    }

    this.data.subscriptions.push(subscription);
    await subscription.addDevice(this.data.id, this.data.transport);

    NexxusRedis.logger.debug(`Added subscription to device with id "${this.data.id}"`);

    return true;
  }

  public async hasSubscription(subscription: NexxusRedisSubscription): Promise<number | null> {
    subscription.setAppId(this.data.appId);

    const localSearchIndex = this.data.subscriptions.findIndex(sub => {
      return sub.getKey() === subscription.getKey();
    });

    if (localSearchIndex !== -1) {
      return localSearchIndex;
    }

    const subs = await NexxusRedis.instance.getClient().json.get(
      `${NEXXUS_PREFIX_LC}:device:${this.data.id}`,
      { path: '$.subscriptions' }
    ) as string[] | null;

    if (subs === null) {
      throw new RedisKeyNotFoundException(`Device with id "${this.data.id}" not found`);
    }

    const index = subs.indexOf(subscription.getKey());

    return index !== -1 ? index : null;
  }

  public async removeSubscription(subscription: NexxusRedisSubscription): Promise<boolean> {
    if (!this.data.transport) {
      throw new RedisDeviceNotConnectedException(`Device with id "${this.data.id}" is not registered with any transport`);
    }

    subscription.setAppId(this.data.appId);

    const index = await this.hasSubscription(subscription);

    if (index === null) {
      NexxusRedis.logger.debug(`Subscription "${subscription.getKey()}" not found on device with id "${this.data.id}"`, { subscriptionKey: subscription.getKey(), deviceId: this.data.id });

      return false;
    }

    const res = await NexxusRedis.instance.getClient().json.arrPop(
      `${NEXXUS_PREFIX_LC}:device:${this.data.id}`,
      {
        path: `$.subscriptions`,
        index: index
      }
    );

    if (res === null) {
      throw new RedisCommandErrorException(`Failed to remove subscription from device with id "${this.data.id}"`);
    }

    await subscription.removeDevice(this.data.id, this.data.transport);

    this.data.subscriptions.splice(index, 1);

    NexxusRedis.logger.debug(`Removed subscription from device with id "${this.data.id}"`);

    return true;
  }

  /**
   * Create the device. ONLY create: this writes the whole document at `$` from
   * `data`, and `data` never carries the session, so overwriting an existing
   * device this way would silently erase its refresh session. `NX` makes that
   * impossible rather than merely discouraged. Change an existing device through
   * `update()` and the session methods, which write single paths.
   */
  public async save(): Promise<void> {
    if (this.data.subscriptions.length > 0 && !this.data.transport) {
      throw new RedisDeviceNotConnectedException(`Device with id "${this.data.id}" must be connected to a transport to have subscriptions`);
    }

    const subscriptionKeys : string[] = this.data.subscriptions.map(sub => sub.getKey());
    const res = await NexxusRedis.instance.getClient().json.set(this.getKey(), '$', {
      ...this.data,
      ...(this.data.lastSeen ? { lastSeen: this.data.lastSeen.toISOString() } : {}),
      subscriptions: subscriptionKeys
    }, { condition: 'NX' });

    if (!res) {
      throw new RedisCommandErrorException(
        `Device with id "${this.data.id}" already exists — save() only creates; use update() to change it`
      );
    }

    for (const subInstance of this.data.subscriptions) {
      await subInstance.addDevice(this.data.id, this.data.transport!);
    }

    NexxusRedis.logger.debug(`Saved device with id "${this.data.id}"`);
  }
}
