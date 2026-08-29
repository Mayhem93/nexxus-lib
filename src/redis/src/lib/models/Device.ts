import { NexxusRedis } from '../Redis';
import {
  RedisCommandErrorException,
  RedisKeyNotFoundException,
  RedisDeviceInvalidParamsException,
  RedisDeviceNotConnectedException
} from '../Exceptions'
import { NexxusRedisBaseModel, RedisKeyType } from './BaseModel';
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
}

export class NexxusDevice extends NexxusRedisBaseModel<NexxusDeviceProps> {
  constructor(props: NexxusDeviceConstructorProps) {
    super(RedisKeyType.Json, {
      id: props.id || crypto.randomUUID(),
      appId: props.appId,
      name: props.name || 'Unnamed Device',
      userId: props.userId,
      type: props.type || 'unknown',
      status: props.status,
      transport: props.transport,
      lastSeen: props.lastSeen ? new Date(props.lastSeen) : undefined,
      subscriptions: props.subscriptions || []
    });

    if (!props.appId) {
      throw new RedisDeviceInvalidParamsException('appId is required to create a Device instance');
    }
  }

  public getKey(): string {
    return NexxusDevice.getKey(this.val.id);
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

  public static async removeAllSubscriptions(deviceId: string): Promise<void> {
    const redis = NexxusRedis.instance.getClient();
    const device = await NexxusDevice.get(deviceId, true);
    const promises : Promise<boolean>[] = [];

    for (const subInstance of device.val.subscriptions) {
      if (device.val.transport) {
        promises.push(subInstance.removeDevice(deviceId, device.val.transport));
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
    if (!this.val.transport) {
      throw new RedisDeviceNotConnectedException(`Device with id "${this.val.id}" is not connected to any transport`);
    }

    const redis = NexxusRedis.instance.getClient();

    subscription.setAppId(this.val.appId);

    const index = await this.hasSubscription(subscription);

    if (index !== null) {
      NexxusRedis.logger.debug(`Subscription "${subscription.getKey()}" already exists on device with id "${this.val.id}"`);

      return false;
    }

    const res = await redis.json.arrAppend(
      `${NEXXUS_PREFIX_LC}:device:${this.val.id}`,
      '$.subscriptions',
      subscription.getKey()
    );

    if (res === null) {
      throw new RedisCommandErrorException(`Failed to add subscription to device with id "${this.val.id}"`);
    }

    this.val.subscriptions.push(subscription);
    await subscription.addDevice(this.val.id, this.val.transport);

    NexxusRedis.logger.debug(`Added subscription to device with id "${this.val.id}"`);

    return true;
  }

  public async hasSubscription(subscription: NexxusRedisSubscription): Promise<number | null> {
    subscription.setAppId(this.val.appId);

    const localSearchIndex = this.val.subscriptions.findIndex(sub => {
      return sub.getKey() === subscription.getKey();
    });

    if (localSearchIndex !== -1) {
      return localSearchIndex;
    }

    const subs = await NexxusRedis.instance.getClient().json.get(
      `${NEXXUS_PREFIX_LC}:device:${this.val.id}`,
      { path: '$.subscriptions' }
    ) as string[] | null;

    if (subs === null) {
      throw new RedisKeyNotFoundException(`Device with id "${this.val.id}" not found`);
    }

    const index = subs.indexOf(subscription.getKey());

    return index !== -1 ? index : null;
  }

  public async removeSubscription(subscription: NexxusRedisSubscription): Promise<boolean> {
    if (!this.val.transport) {
      throw new RedisDeviceNotConnectedException(`Device with id "${this.val.id}" is not registered with any transport`);
    }

    subscription.setAppId(this.val.appId);

    const index = await this.hasSubscription(subscription);

    if (index === null) {
      NexxusRedis.logger.debug(`Subscription "${subscription.getKey()}" not found on device with id "${this.val.id}"`, { subscriptionKey: subscription.getKey(), deviceId: this.val.id });

      return false;
    }

    const res = await NexxusRedis.instance.getClient().json.arrPop(
      `${NEXXUS_PREFIX_LC}:device:${this.val.id}`,
      {
        path: `$.subscriptions`,
        index: index
      }
    );

    if (res === null) {
      throw new RedisCommandErrorException(`Failed to remove subscription from device with id "${this.val.id}"`);
    }

    await subscription.removeDevice(this.val.id, this.val.transport);

    this.val.subscriptions.splice(index, 1);

    NexxusRedis.logger.debug(`Removed subscription from device with id "${this.val.id}"`);

    return true;
  }

  public async save(): Promise<void> {
    if (this.val.subscriptions.length > 0 && !this.val.transport) {
      throw new RedisDeviceNotConnectedException(`Device with id "${this.val.id}" must be connected to a transport to have subscriptions`);
    }

    const subscriptionKeys : string[] = this.val.subscriptions.map(sub => sub.getKey());
    const res = await NexxusRedis.instance.getClient().json.set(this.getKey(), '$', {
      ...this.val,
      ...(this.val.lastSeen ? { lastSeen: this.val.lastSeen.toISOString() } : {}),
      subscriptions: subscriptionKeys
    });

    if (!res) {
      throw new RedisCommandErrorException(`Failed to save device with id "${this.val.id}"`);
    }

    for (const subInstance of this.val.subscriptions) {
      await subInstance.addDevice(this.val.id, this.val.transport!);
    }

    NexxusRedis.logger.debug(`Saved device with id "${this.val.id}"`);
  }
}
