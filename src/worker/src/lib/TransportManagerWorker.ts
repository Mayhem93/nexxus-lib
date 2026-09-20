import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusQueueName,
  NexxusTransportManagerPayload,
  NexxusModelCreatedPayload,
  NexxusTransportManagerModelUpdatedPayload,
  NexxusModelDeletedPayload,
  NexxusBaseQueuePayload,
  NexxusFilterQuery,
  INexxusAppModel,
  NexxusModelDef,
} from '@mayhem93/nexxus-core-lib';
import { NexxusQueueMessage } from '@mayhem93/nexxus-message-queue-lib';
import {
  NexxusBaseSubscriptionChannel,
  NexxusRedisSubscription,
  NexxusDeviceTransportString
} from '@mayhem93/nexxus-redis';

import {
  NexxusBaseWorker,
  NexxusBaseWorkerEvents,
  NexxusBaseWorkerConfig,
  NexxusBaseWorkerStats,
  NexxusWorkerServices
} from './BaseWorker';

import * as path from 'node:path';

export type NexxusTransportManagerWorkerConfig = NexxusBaseWorkerConfig & {
  name: string;
  /** Class name of the logger service (see `NexxusApiConfig.logger`). */
  logger: string;
  /** Class name of the database adapter (see `NexxusApiConfig.database`). */
  database: string;
  /** Class name of the message-queue adapter (see `NexxusApiConfig.message_queue`). */
  message_queue: string;
}

type NexxusTransportManagerWorkerEvents = NexxusBaseWorkerEvents & {
  message: [string];
}

type NexxusTransportManagerWorkerStats = NexxusBaseWorkerStats & {}

/**
 * One fan-out message's worth of recipients: every device that matched the
 * exact same set of channels, and therefore shares a single transport payload.
 */
type NexxusFanOutGroup = {
  channels: string[];
  deviceIds: string[];
};

export class NexxusTransportManagerWorker extends NexxusBaseWorker<
  NexxusTransportManagerWorkerConfig,
  NexxusTransportManagerWorkerEvents,
  NexxusTransportManagerPayload,
  NexxusTransportManagerWorkerStats
> {
  protected nodeRole: string = 'transport-manager';
  protected queueName: NexxusQueueName = 'transport-manager';
  protected static loggerLabel: Readonly<string> = 'NxxTransportManagerWorker';
  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];
  protected static schemaPath: string = path.join(__dirname, '../../src/schemas/transport-manager-worker.schema.json');

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  protected async processMessage(msg: NexxusQueueMessage<NexxusTransportManagerPayload>): Promise<void> {
    NexxusTransportManagerWorker.logger.debug('Processing message', { payload: msg.payload }, NexxusTransportManagerWorker.loggerLabel);

    const payload = msg.payload;

    switch (payload.event) {
      case 'model_created': {
        await this.handleModelCreated(payload.data);

        NexxusTransportManagerWorker.logger.debug('Processing model created',
          { id: payload.data.id, appId: payload.data.appId, type: payload.data.type },
          NexxusTransportManagerWorker.loggerLabel
        );

        break;
      }

      case 'model_updated': {
        await this.handleModelUpdated(payload.data);

        NexxusTransportManagerWorker.logger.debug('Processing model update',
          { id: payload.data[0].metadata.id, appId: payload.data[0].metadata.appId, type: payload.data[0].metadata.type },
          NexxusTransportManagerWorker.loggerLabel
        );

        break;
      }

      case 'model_deleted': {
        await this.handleModelDeleted(payload.data);

        NexxusTransportManagerWorker.logger.debug('Processing model delete',
          { id: payload.data.id, appId: payload.data.appId, type: payload.data.type }, NexxusTransportManagerWorker.loggerLabel
        );

        break;
      }
      default:
        NexxusTransportManagerWorker.logger.warn(`Unknown event type: ${(payload as NexxusBaseQueuePayload).event}`,
          { type: (payload as NexxusBaseQueuePayload).event }, NexxusTransportManagerWorker.loggerLabel
        );
    }
  }

  private async handleModelCreated(data: NexxusModelCreatedPayload['data']): Promise<void> {
    const deviceToChannelsMap = await this.getDevicesFromGeneratedChannels({
      appId: data.appId,
      userId: data.userId,
      model: data.type,
      modelId: data.id
    }, [ data ]);

    for (const [transport, groups] of this.groupDevicesForFanOut(deviceToChannelsMap).entries()) {
      let deviceCount = 0;

      for (const { channels, deviceIds } of groups) {
        deviceCount += deviceIds.length;

        this.publish(transport, {
          event: 'device_message',
          deviceIds,
          data: {
            event: 'model_created',
            model: data,
            metadata: {
              channels
            }
          }
        });
      }

      NexxusTransportManagerWorker.logger.info(
        `Notifying ${deviceCount} devices about new model with ID: "${data.id}" via transport: "${transport}" ` +
        `in ${groups.length} message(s)`,
        {
          appId: data.appId,
          modelId: data.id,
          modelType: data.type,
          transport,
          deviceCount,
          messageCount: groups.length
        },
        NexxusTransportManagerWorker.loggerLabel
      );
    }
  }

  private async handleModelUpdated(data: NexxusTransportManagerModelUpdatedPayload['data']): Promise<void> {
    const channel = {
      appId: data[0].metadata.appId!,
      userId: data[0].metadata.userId,
      model: data[0].metadata.type,
      modelId: data[0].metadata.id
    };

    // Get map of devices -> matching channel keys. Updates match filters
    // against each patch's post-update partial model.
    const deviceToChannelsMap = await this.getDevicesFromGeneratedChannels(
      channel,
      data.map(patch => patch.metadata.partialModel)
    );

    // All patches in a single model_updated event target the same model; identity
    // and patch ops are constant across devices — compute once, reuse per recipient.
    // The post-update `version` comes from the writer's partial (populated by the
    // adapter on the bulk update) — every patch in this batch shares it.
    const modelIdentity = {
      id: data[0].metadata.id,
      type: data[0].metadata.type,
      appId: data[0].metadata.appId,
      userId: data[0].metadata.userId,
      version: data[0].metadata.partialModel.version,
    };
    const patches = data.map(patch => ({
      op: patch.op,
      path: patch.path,
      value: patch.value,
    }));

    for (const [transport, groups] of this.groupDevicesForFanOut(deviceToChannelsMap).entries()) {
      let deviceCount = 0;

      for (const { channels, deviceIds } of groups) {
        deviceCount += deviceIds.length;

        this.publish(transport, {
          event: 'device_message',
          deviceIds,
          data: {
            event: 'model_updated',
            model: modelIdentity,
            patches,
            metadata: { channels },
          }
        });
      }

      NexxusTransportManagerWorker.logger.info(
        `Notified ${deviceCount} devices about update to model ID: "${data[0].metadata.id}" via transport: "${transport}" ` +
        `in ${groups.length} message(s)`,
        {
          appId: data[0].metadata.appId,
          modelId: data[0].metadata.id,
          modelType: data[0].metadata.type,
          transport,
          deviceCount,
          messageCount: groups.length
        },
        NexxusTransportManagerWorker.loggerLabel
      );
    }
  }

  private async handleModelDeleted(data: NexxusModelDeletedPayload['data']): Promise<void> {
    // Deletes carry only identity fields (id/type/appId/userId), which is
    // enough to match ownership-style filters (e.g. userId == me) so filtered
    // subscribers are notified; filters on other fields can't be tested here.
    const deviceToChannelsMap = await this.getDevicesFromGeneratedChannels({
      appId: data.appId,
      userId: data.userId,
      model: data.type,
      modelId: data.id
    }, [ data ]);

    for (const [transport, groups] of this.groupDevicesForFanOut(deviceToChannelsMap).entries()) {
      let deviceCount = 0;

      for (const { channels, deviceIds } of groups) {
        deviceCount += deviceIds.length;

        this.publish(transport, {
          event: 'device_message',
          deviceIds,
          data: {
            event: 'model_deleted',
            model: data,
            metadata: {
              channels
            }
          }
        });
      }

      NexxusTransportManagerWorker.logger.info(
        `Notifying ${deviceCount} devices about deleted model with ID: "${data.id}" via transport: "${transport}" ` +
        `in ${groups.length} message(s)`,
        {
          appId: data.appId,
          modelId: data.id,
          modelType: data.type,
          transport,
          deviceCount,
          messageCount: groups.length
        },
        NexxusTransportManagerWorker.loggerLabel
      );
    }
  }

  /**
   * Batches the flat device→channels map into as few transport messages as
   * possible: one per (transport, distinct channel set).
   *
   * A `device_message` carries `deviceIds` as an array precisely so a single
   * publish can serve many devices, but its `metadata.channels` is shared by
   * every recipient in that message — clients use it to correlate the event
   * with their local subscription containers, so devices that matched on
   * different channels cannot be merged into the same message. Devices that
   * matched the *same* channels can, which is the common case: most recipients
   * come from the same unfiltered channel, so a fan-out to N devices collapses
   * to a handful of messages instead of N.
   */
  private groupDevicesForFanOut(
    deviceToChannelsMap: Map<NexxusDeviceTransportString, Set<string>>
  ): Map<NexxusQueueName, NexxusFanOutGroup[]> {
    const transportToGroups = new Map<NexxusQueueName, Map<string, NexxusFanOutGroup>>();

    for (const [deviceTransport, channelKeys] of deviceToChannelsMap.entries()) {
      const [deviceId, transport] = deviceTransport.split('|') as [string, NexxusQueueName];
      // Sorted so two devices that matched the same channels in a different
      // order still land in the same group. Channel keys are colon-delimited
      // and never contain a newline, so it's a collision-free separator.
      const channels = Array.from(channelKeys).sort();
      const signature = channels.join('\n');

      let groups = transportToGroups.get(transport);

      if (!groups) {
        groups = new Map();
        transportToGroups.set(transport, groups);
      }

      const existing = groups.get(signature);

      if (existing) {
        existing.deviceIds.push(deviceId);
      } else {
        groups.set(signature, { channels, deviceIds: [ deviceId ] });
      }
    }

    return new Map(
      Array.from(transportToGroups.entries()).map(([transport, groups]) => [transport, Array.from(groups.values())])
    );
  }

  /**
   * Resolves every device that should hear about a change on `channel`, mapped
   * to the channel keys it matched on.
   *
   * `filterTargets` are the model-shaped objects filtered subscriptions get
   * tested against (empty for events that carry none). Callers normalize each
   * event's shape: creates pass the new model, updates the per-patch
   * post-update partial model, deletes the deleted model's identity fields.
   */
  private async getDevicesFromGeneratedChannels(
    channel: NexxusBaseSubscriptionChannel,
    filterTargets: Array<Partial<INexxusAppModel>> = []
  ): Promise<Map<NexxusDeviceTransportString, Set<string>>> {
    const deviceToChannelsMap = new Map<NexxusDeviceTransportString, Set<string>>();

    const app = NexxusTransportManagerWorker.loadedApps.get(channel.appId);

    if (!app) {
      NexxusTransportManagerWorker.logger.warn(
        `Application not found for appId: "${channel.appId}" when getting devices for channel: ${JSON.stringify(channel)}`,
        NexxusTransportManagerWorker.loggerLabel
      );

      return deviceToChannelsMap;
    }

    // Every generated pattern below shares this channel's `model`, so the
    // schema filters get compiled against is constant for the whole call.
    // getAppModelSchema() deep-clones the model's fields on every call, so
    // resolve it at most once — lazily, because it throws for a model type the
    // app doesn't declare and channels with no filtered subscriber never need it.
    let appModelSchema: NexxusModelDef | undefined;
    const getAppModelSchema = (): NexxusModelDef => appModelSchema ??= app.getAppModelSchema(channel.model);

    // Fetch the scope registry ONCE per event. This tells us which
    // (modelId/userId) combinations have any subscriber at all — patterns
    // not present here are skipped entirely instead of doing a speculative
    // Redis lookup that would (a) almost always miss and (b) bloat Redis's
    // client-tracking table with forever-stale entries.
    const activeScopes = await NexxusRedisSubscription.getActiveScopes(channel.appId, channel.model);

    if (activeScopes.size === 0) {
      // Nobody subscribed to this (appId, model) at any scope. Done.
      return deviceToChannelsMap;
    }

    // Generate all base channels (without filters)
    const baseChannels = NexxusRedisSubscription.generateSubscriptionPatterns(channel);

    for (const channelPattern of baseChannels) {
      // Skip patterns whose scope has no subscribers — the work done below
      // for this pattern would all be empty answers.
      if (!activeScopes.has(NexxusRedisSubscription.buildScopeDescriptor(channelPattern))) {
        continue;
      }

      // Get devices from unfiltered subscription
      const unfilteredSub = new NexxusRedisSubscription(channelPattern);
      const unfilteredChannelKey = unfilteredSub.getKey();
      const unfilteredDevices = await unfilteredSub.getAllDevices();

      // Add unfiltered channel to each device
      for (const deviceId of unfilteredDevices) {
        if (!deviceToChannelsMap.has(deviceId)) {
          deviceToChannelsMap.set(deviceId, new Set());
        }
        deviceToChannelsMap.get(deviceId)!.add(unfilteredChannelKey);
      }

      if (unfilteredDevices.size > 0) {
        NexxusTransportManagerWorker.logger.debug(
          `Found ${unfilteredDevices.size} devices for unfiltered channel: ${unfilteredChannelKey}`,
          {
            channel: channelPattern,
            size: unfilteredDevices.size,
            changesCount: filterTargets.length
          },
          NexxusTransportManagerWorker.loggerLabel
        );
      }

      // Filtered subscriptions match only when there's an object to test the
      // filter against. Creates/updates/deletes all supply one (see callers);
      // `filterTargets` is empty only for events that carry none.
      if (filterTargets.length > 0) {
        const filters = await NexxusRedisSubscription.getAllFilters(channelPattern);

        // For each filter, test if ANY change matches
        for (const [filterId, filterQuery] of Object.entries(filters)) {
          const filter = new NexxusFilterQuery(filterQuery, getAppModelSchema());
          const matchesFilter = filterTargets.some(change => filter.test(change));

          if (matchesFilter) {
            const filteredSub = new NexxusRedisSubscription(channelPattern, filterId);
            const filteredChannelKey = filteredSub.getKey();
            const filteredDevices = await filteredSub.getAllDevices();

            // Add filtered channel to each device
            for (const deviceId of filteredDevices) {
              if (!deviceToChannelsMap.has(deviceId)) {
                deviceToChannelsMap.set(deviceId, new Set());
              }
              deviceToChannelsMap.get(deviceId)!.add(filteredChannelKey);
            }

            if (filteredDevices.size > 0) {
              NexxusTransportManagerWorker.logger.debug(
                `Found ${filteredDevices.size} devices for filtered channel: ${filteredChannelKey}`,
                {
                  channel: channelPattern,
                  size: filteredDevices.size,
                  changesCount: filterTargets.length
                },
                NexxusTransportManagerWorker.loggerLabel
              );
            }
          }
        }
      }
    }

    NexxusTransportManagerWorker.logger.info(
      `Total ${deviceToChannelsMap.size} unique devices to notify for channel: ${JSON.stringify(channel)}`,
      {
        channel,
        size: deviceToChannelsMap.size
      },
      NexxusTransportManagerWorker.loggerLabel
    );

    return deviceToChannelsMap;
  }
}
