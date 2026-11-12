import { NexxusRedis } from '../Redis';
import {
  NexxusFilterQuery,
  NexxusFilterQueryType,
  NEXXUS_PREFIX_LC
} from '@mayhem93/nexxus-core-lib';

import crypto from 'crypto';

/** A route: one connection of a device, as `deviceId|transport|connectionId`. */
export type NexxusDeviceTransportString = `${string}|${string}|${string}`;

export interface NexxusSubscriptionChannel {
  appId: string;
  model: string;
  modelId?: string;
  userId?: string;
  filter?: NexxusFilterQuery;
}

export type NexxusBaseSubscriptionChannel = Omit<NexxusSubscriptionChannel, 'filter'>;

export class NexxusRedisSubscription {
  private static readonly PARTITION_COUNT = 16;

  /**
   * Prefix of the filter registry fields that count a filter's members, next
   * to the field holding its definition. Filter ids are hex, so no definition
   * field starts with it.
   */
  private static readonly FILTER_COUNT_PREFIX = 'count:';

  private channel: NexxusSubscriptionChannel;
  private filterId?: string;

  constructor(channel: NexxusSubscriptionChannel, filterId?: string) {
    this.channel = channel;

    // If channel has a filter, generate filter ID
    if (channel.filter) {
      this.filterId = NexxusRedisSubscription.generateFilterId(channel.filter);
    } else if (filterId) {
      this.filterId = filterId;
    }
  }

  public setAppId(appId: string): void {
    this.channel.appId = appId;
  }

  public getKey(): string {
    let key = `${NEXXUS_PREFIX_LC}:subscription:${this.channel.appId}:${this.channel.model}`;

    if (this.channel.modelId) {
      key += `:${this.channel.modelId}`;
    }

    // it's redundant to have both modelId and userId
    if (this.channel.userId && !this.channel.modelId ) {
      key += `:user:${this.channel.userId}`;
    }

    if (this.filterId) {
      key += `:filter:${this.filterId}`;
    }

    return key;
  }

  public static fromKey(key: string): NexxusRedisSubscription {
    // Remove prefix: "nexxus:subscription:"
    const withoutPrefix = key.replace(`${NEXXUS_PREFIX_LC}:subscription:`, '');
    const parts = withoutPrefix.split(':');

    // Structure: appId:model[:modelId][:user:userId][:filter:filterId]
    const appId = parts[0];
    const model = parts[1];

    let modelId: string | undefined;
    let userId: string | undefined;
    let filterId: string | undefined;

    // Parse remaining parts
    let i = 2;

    while (i < parts.length) {
      const part = parts[i];

      if (part === 'user') {
        userId = parts[i + 1];
        i += 2;
      } else if (part === 'filter') {
        filterId = parts[i + 1];
        i += 2;
      } else {
        // It's the modelId (appears right after model type identifier, before any keywords)
        modelId = part;
        i += 1;
      }
    }

    return new NexxusRedisSubscription({ appId, model, modelId, userId }, filterId);
  }


  /**
   * Route this channel to one connection of a device, as the member
   * `deviceId|transport|connectionId`. Returns whether the route is new.
   */
  public addConnection(deviceId: string, transport: string, connectionId: string): Promise<boolean> {
    return this.addMember(deviceId, `${deviceId}|${transport}|${connectionId}`);
  }

  /**
   * Remove this channel's route to one connection of a device. Returns whether
   * there was one: of several callers removing the same route, only one gets
   * `true`, and only that one releases its counts.
   */
  public removeConnection(deviceId: string, transport: string, connectionId: string): Promise<boolean> {
    return this.removeMember(deviceId, `${deviceId}|${transport}|${connectionId}`);
  }

  /**
   * Add a member to the device's partition. Returns whether it is new.
   *
   * The member is counted before it is added, and released only after it is
   * removed (see `removeMember`). So a member that exists is always counted
   * everywhere the Transport Manager looks before reading members, whatever
   * other members are added or removed at the same moment.
   */
  private async addMember(deviceId: string, member: string): Promise<boolean> {
    const partition = this.getDevicePartition(deviceId);

    await this.retain(partition);

    if (await NexxusRedis.instance.getClient().sAdd(this.buildPartitionKey(partition), member) === 0) {
      // Already a member, and already counted.
      await this.release(partition);

      return false;
    }

    return true;
  }

  /** Remove a member from the device's partition. Returns whether it was there. */
  private async removeMember(deviceId: string, member: string): Promise<boolean> {
    const partition = this.getDevicePartition(deviceId);

    // Of several callers removing the same member, only the one that removes it
    // releases its counts.
    if (await NexxusRedis.instance.getClient().sRem(this.buildPartitionKey(partition), member) === 0) {
      return false;
    }

    await this.release(partition);

    return true;
  }

  /**
   * Count one more member on the three things the Transport Manager reads
   * before members: the scope, the member's partition, and the filter of a
   * filtered subscription, whose definition is stored too.
   */
  private async retain(partition: string): Promise<void> {
    const redis = NexxusRedis.instance.getClient();
    const counts: Promise<unknown>[] = [
      redis.hIncrBy(
        NexxusRedisSubscription.buildScopeRegistryKey(this.channel.appId, this.channel.model),
        NexxusRedisSubscription.buildScopeDescriptor(this.channel),
        1
      ),
      redis.hIncrBy(this.buildPartitionIndexKey(), partition, 1)
    ];

    if (this.filterId) {
      counts.push(this.retainFilter(this.filterId));
    }

    await Promise.all(counts);
  }

  /**
   * The count before the definition: a release landing in between then can't
   * take the count to zero and delete the definition stored here.
   */
  private async retainFilter(filterId: string): Promise<void> {
    const redis = NexxusRedis.instance.getClient();
    const key = this.buildFilterRegistryKey();

    await redis.hIncrBy(key, NexxusRedisSubscription.filterCountField(filterId), 1);

    // A subscription rebuilt from its key has no query to store.
    if (this.channel.filter) {
      await redis.hSet(key, filterId, JSON.stringify(this.channel.filter.getNormalizedQuery()));
    }
  }

  /**
   * Count one member fewer on everything `retain` counted it on, deleting each
   * count once it reaches zero, and the filter's definition with its count.
   * Each release is one step, so a member counted at the same moment never
   * loses its count to it.
   */
  private async release(partition: string): Promise<void> {
    const scripts = NexxusRedis.instance.scripts;
    const releases: Promise<number>[] = [
      scripts.run('counter-release', {
        keys: [ NexxusRedisSubscription.buildScopeRegistryKey(this.channel.appId, this.channel.model) ],
        args: [ NexxusRedisSubscription.buildScopeDescriptor(this.channel) ]
      }),
      scripts.run('counter-release', { keys: [ this.buildPartitionIndexKey() ], args: [ partition ] })
    ];

    if (this.filterId) {
      releases.push(scripts.run('counter-release', {
        keys: [ this.buildFilterRegistryKey() ],
        args: [ NexxusRedisSubscription.filterCountField(this.filterId), this.filterId ]
      }));
    }

    await Promise.all(releases);
  }

  /** The filter registry field counting the members a filter has. */
  private static filterCountField(filterId: string): string {
    return `${NexxusRedisSubscription.FILTER_COUNT_PREFIX}${filterId}`;
  }

  public async getAllDevices(): Promise<Set<NexxusDeviceTransportString>> {
    const devices = new Set<NexxusDeviceTransportString>();
    const redis = NexxusRedis.instance.getClient();
    const partitionIndexKey = this.buildPartitionIndexKey();

    // Get list of partitions that have devices
    const activePartitions = await redis.hKeys(partitionIndexKey);

    if (activePartitions.length === 0) {
      return devices; // No devices subscribed
    }

    // Only fetch active partitions
    const promises = activePartitions.map(partition => {
      const key = this.buildPartitionKey(partition);

      return redis.sMembers(key);
    });

    const results = await Promise.all(promises);

    results.forEach(deviceList => {
      deviceList.forEach(d => devices.add(d as NexxusDeviceTransportString));
    });

    return devices;
  }

  public static *generateSubscriptionPatterns(data: NexxusBaseSubscriptionChannel): Generator<NexxusSubscriptionChannel> {
    const { appId, userId, model, modelId } = data;

    // Level 1: App model only subscription
    yield { appId, model };

    // Level 2: Add userId dimension
    if (userId) {
      yield { appId, model, userId };
    }

    // Level 3: Add modelId
    if (modelId) {
      yield { appId, model, modelId };

      // Level 4: userId + modelId (most specific)
      if (userId) {
        yield { appId, model, modelId, userId };
      }
    }
  }

  // Private helpers
  private getDevicePartition(deviceId: string): string {
    const hash = crypto.createHash('sha256').update(deviceId).digest();
    const partitionNum = hash[0] % NexxusRedisSubscription.PARTITION_COUNT;

    return partitionNum.toString(16).toLowerCase();
  }

  private static generateFilterId(filter: NexxusFilterQuery): string {
    const normalized = JSON.stringify(filter.getNormalizedQuery());

    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  public static async getAllFilters(channel: NexxusSubscriptionChannel): Promise<Record<string, NexxusFilterQueryType>> {
    const redis = NexxusRedis.instance.getClient();

    // Build the filter registry key for this channel
    const filterRegistryKey = this.buildFilterRegistryKey(channel);

    // Get all the filters
    const filters = await redis.hGetAll(filterRegistryKey);

    return Object.fromEntries(
      Object.entries(filters)
        .filter(([ field ]) => !field.startsWith(NexxusRedisSubscription.FILTER_COUNT_PREFIX))
        .map(([ filterId, filterJson ]) => [ filterId, JSON.parse(filterJson) as NexxusFilterQueryType ])
    );
  }

  /**
   * Returns the set of scope descriptors that currently have at least one
   * subscriber for `(appId, model)`. The Transport Manager consults this
   * before iterating `generateSubscriptionPatterns` output — patterns whose
   * descriptor isn't in the returned set are skipped entirely, avoiding
   * pointless Redis lookups (and their tracking-table cost) for scopes
   * nobody subscribes at.
   */
  public static async getActiveScopes(appId: string, model: string): Promise<Set<string>> {
    const redis = NexxusRedis.instance.getClient();
    const key = this.buildScopeRegistryKey(appId, model);
    const fields = await redis.hKeys(key);

    return new Set(fields);
  }

  /**
   * Canonical descriptor for a subscription's scope dimensions, used as the
   * HASH field name in the scope registry. Order is deterministic so two
   * subscriptions with the same scope produce the same descriptor.
   *
   *   { appId, model }                                 → '*'
   *   { appId, model, modelId: 'X' }                   → 'id:X'
   *   { appId, model, userId: 'U' }                    → 'user:U'
   *   { appId, model, modelId: 'X', userId: 'U' }      → 'id:X|user:U'
   *
   * Filter ID is intentionally NOT part of the descriptor — filters are
   * tracked by the parallel filter registry.
   */
  public static buildScopeDescriptor(channel: NexxusBaseSubscriptionChannel): string {
    const parts: string[] = [];

    if (channel.modelId) {
      parts.push(`id:${channel.modelId}`);
    }

    if (channel.userId) {
      parts.push(`user:${channel.userId}`);
    }

    return parts.length === 0 ? '*' : parts.join('|');
  }

  private static buildScopeRegistryKey(appId: string, model: string): string {
    return `${NEXXUS_PREFIX_LC}:subscription-scopes:${appId}:${model}`;
  }

  private buildPartitionKey(partition: string): string {
    let key = `${NEXXUS_PREFIX_LC}:subscription:${this.channel.appId}:${this.channel.model}`;

    if (this.channel.modelId) {
      key += `:${this.channel.modelId}`;
    }

    if (this.channel.userId && !this.channel.modelId) {
      key += `:user:${this.channel.userId}`;
    }

    if (this.filterId) {
      key += `:filter:${this.filterId}`;
    }

    key += `:p${partition}`;

    return key;
  }

  /**
   * How many members each partition holds, as a HASH: partition → count. A
   * partition with none has no field.
   */
  private buildPartitionIndexKey(): string {
    let key = `${NEXXUS_PREFIX_LC}:subscription-partition-index:${this.channel.appId}:${this.channel.model}`;

    if (this.channel.modelId) {
      key += `:${this.channel.modelId}`;
    }

    if (this.channel.userId && !this.channel.modelId) {
      key += `:user:${this.channel.userId}`;
    }

    if (this.filterId) {
      key += `:filter:${this.filterId}`;
    }

    return key;
  }

  private buildFilterRegistryKey(): string {
    return NexxusRedisSubscription.buildFilterRegistryKey(this.channel);
  }

  private static buildFilterRegistryKey(channel: NexxusSubscriptionChannel): string {
    let key = `${NEXXUS_PREFIX_LC}:subscription-filters:${channel.appId}:${channel.model}`;

    if (channel.modelId) {
      key += `:${channel.modelId}`;
    }

    if (channel.userId && !channel.modelId) {
      key += `:user:${channel.userId}`;
    }

    return key;
  }
}
