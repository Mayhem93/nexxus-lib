import { NexxusRedis } from '../Redis';
import {
  NexxusFilterQuery,
  NexxusFilterQueryType,
  NEXXUS_PREFIX_LC
} from '@mayhem93/nexxus-core-lib';

import crypto from 'crypto';

export type NexxusDeviceTransportString = `${string}|${string}`; // deviceId|transport

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


  public async addDevice(deviceId: string, transport: string): Promise<void> {
    const partition = this.getDevicePartition(deviceId);
    const partitionKey = this.buildPartitionKey(partition);
    const partitionIndexKey = this.buildPartitionIndexKey();

    const redis = NexxusRedis.instance.getClient();

    // SADD returns the number of NEW members added. If it returns 0 the
    // device was already subscribed to this exact channel — bail so we
    // don't double-count the scope HINCRBY below.
    const added = await redis.sAdd(partitionKey, `${deviceId}|${transport}`);

    if (added === 0) {
      return;
    }

    // Track that this partition exists.
    await redis.sAdd(partitionIndexKey, partition);

    // Bump the scope counter. TM reads this to know which (modelId/userId)
    // combinations have ANY subscriber at all — patterns nobody subscribed
    // to are skipped entirely, avoiding the per-pattern Redis lookups that
    // were producing forever-stale tracking-table entries.
    const scopeRegistryKey = NexxusRedisSubscription.buildScopeRegistryKey(this.channel.appId, this.channel.model);
    const scopeDescriptor = NexxusRedisSubscription.buildScopeDescriptor(this.channel);

    await redis.hIncrBy(scopeRegistryKey, scopeDescriptor, 1);

    // If filtered subscription, store filter definition.
    if (this.filterId && this.channel.filter) {
      const filterKey = this.buildFilterRegistryKey();

      await redis.hSet(filterKey, this.filterId, JSON.stringify(this.channel.filter.getNormalizedQuery()));
    }
  }

  public async removeDevice(deviceId: string, transport: string): Promise<boolean> {
    const redis = NexxusRedis.instance.getClient();
    const partition = this.getDevicePartition(deviceId);
    const partitionKey = this.buildPartitionKey(partition);
    const removed = await redis.sRem(partitionKey, `${deviceId}|${transport}`);

    if (removed === 0) {
      return false;
    }

    // Partition cleanup is conditional: 16 partitions hash-bucket devices, so
    // multiple devices share a partition. Only drop the partition from the
    // index when THIS partition is now empty; only drop per-subscription
    // registries (filter HASH) when the subscription is fully empty.
    if (await redis.sCard(partitionKey) === 0) {
      const partitionIndexKey = this.buildPartitionIndexKey();

      await redis.sRem(partitionIndexKey, partition);

      if (await redis.sCard(partitionIndexKey) === 0 && this.filterId) {
        await redis.hDel(this.buildFilterRegistryKey(), this.filterId);
      }
    }

    // Scope counter tracks "how many devices subscribe at this scope
    // across all partitions and filters", so it always decrements when
    // a device successfully unsubscribes. HINCRBY returns the new value;
    // HDEL the field when it hits zero so HKEYS doesn't return stale scopes.
    const scopeRegistryKey = NexxusRedisSubscription.buildScopeRegistryKey(this.channel.appId, this.channel.model);
    const scopeDescriptor = NexxusRedisSubscription.buildScopeDescriptor(this.channel);
    const newCount = await redis.hIncrBy(scopeRegistryKey, scopeDescriptor, -1);

    if (newCount <= 0) {
      await redis.hDel(scopeRegistryKey, scopeDescriptor);
    }

    return true;
  }

  public async getAllDevices(): Promise<Set<NexxusDeviceTransportString>> {
    const devices = new Set<NexxusDeviceTransportString>();
    const redis = NexxusRedis.instance.getClient();
    const partitionIndexKey = this.buildPartitionIndexKey();

    // Get list of partitions that have devices
    const activePartitions = await redis.sMembers(partitionIndexKey);

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

    // Level 4: Add modelId
    if (modelId) {
      yield { appId, model, modelId };
    }

    // Level 5: userId + model combination
    if (userId) {
      yield { appId, userId, model };

      // Level 6: userId + model + modelId (most specific)
      if (modelId) {
        yield { appId, userId, model, modelId };
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
      Object.entries(filters).map(([filterId, filterJson]) => [
        filterId,
        JSON.parse(filterJson) as NexxusFilterQueryType
      ])
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

  private buildPartitionIndexKey(): string {
    let key = `${NEXXUS_PREFIX_LC}:subscription-partitions:${this.channel.appId}:${this.channel.model}`;

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
