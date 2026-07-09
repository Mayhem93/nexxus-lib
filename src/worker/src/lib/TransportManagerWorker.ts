import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusQueueName,
  NexxusTransportManagerPayload,
  NexxusModelCreatedPayload,
  NexxusTransportManagerModelUpdatedPayload,
  NexxusTransportManagerJsonPatch,
  NexxusModelDeletedPayload,
  NexxusBaseQueuePayload,
  NexxusFilterQuery,
  INexxusAppModel,
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
    }, data);
    const transportToDeviceChannelsMap: Map<NexxusQueueName, Map<string, string[]>> = new Map();

    for (const [deviceTransport, channelKeys] of deviceToChannelsMap.entries()) {
      const [deviceId, transport] = deviceTransport.split('|');

      if (!transportToDeviceChannelsMap.has(transport as NexxusQueueName)) {
        transportToDeviceChannelsMap.set(transport as NexxusQueueName, new Map());
      }

      transportToDeviceChannelsMap.get(transport as NexxusQueueName)!.set(deviceId, Array.from(channelKeys));
    }

    for (const [transport, deviceChannelsMap] of transportToDeviceChannelsMap.entries()) {
      for (const [deviceId, channelKeys] of deviceChannelsMap.entries()) {
        this.publish(transport as NexxusQueueName, {
          event: 'device_message',
          deviceIds: [ deviceId ],
          data: {
            event: 'model_created',
            model: data,
            metadata: {
              channels: channelKeys
            }
          }
        });
      }

      NexxusTransportManagerWorker.logger.info(
        `Notifying ${deviceChannelsMap.size} devices about new model with ID: "${data.id}" via transport: "${transport}"`,
        {
          appId: data.appId,
          modelId: data.id,
          modelType: data.type,
          transport,
          deviceCount: deviceChannelsMap.size
        },
        NexxusTransportManagerWorker.loggerLabel
      );
    }
  }

  private async handleModelUpdated(data: NexxusTransportManagerModelUpdatedPayload['data']): Promise<void> {
    const channel = {
      appId: data[0].metadata.appId,
      userId: data[0].metadata.userId,
      model: data[0].metadata.type,
      modelId: data[0].metadata.id
    };

    // Get map of devices -> matching channel keys
    const deviceToChannelsMap = await this.getDevicesFromGeneratedChannels(channel, data);

    // Group by transport
    const transportToDeviceChannelsMap: Map<NexxusQueueName, Map<string, string[]>> = new Map();

    for (const [deviceTransport, channelKeys] of deviceToChannelsMap.entries()) {
      const [deviceId, transport] = deviceTransport.split('|');

      if (!transportToDeviceChannelsMap.has(transport as NexxusQueueName)) {
        transportToDeviceChannelsMap.set(transport as NexxusQueueName, new Map());
      }

      transportToDeviceChannelsMap.get(transport as NexxusQueueName)!.set(deviceId, Array.from(channelKeys));
    }

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

    for (const [transport, deviceChannelsMap] of transportToDeviceChannelsMap.entries()) {
      for (const [deviceId, channelKeys] of deviceChannelsMap.entries()) {
        this.publish(transport as NexxusQueueName, {
          event: 'device_message',
          deviceIds: [ deviceId ],
          data: {
            event: 'model_updated',
            model: modelIdentity,
            patches,
            metadata: { channels: channelKeys },
          }
        });
      }

      NexxusTransportManagerWorker.logger.info(
        `Notified ${deviceChannelsMap.size} devices about update to model ID: "${data[0].metadata.id}" via transport: "${transport}"`,
        {
          appId: data[0].metadata.appId,
          modelId: data[0].metadata.id,
          modelType: data[0].metadata.type,
          transport,
          deviceCount: deviceChannelsMap.size
        },
        NexxusTransportManagerWorker.loggerLabel
      );
    }
  }

  private async handleModelDeleted(data: NexxusModelDeletedPayload['data']): Promise<void> {
    const deviceToChannelsMap = await this.getDevicesFromGeneratedChannels({
      appId: data.appId,
      userId: data.userId,
      model: data.type,
      modelId: data.id
    });
    const transportToDeviceChannelsMap: Map<NexxusQueueName, Map<string, string[]>> = new Map();

    for (const [deviceTransport, channelKeys] of deviceToChannelsMap.entries()) {
      const [deviceId, transport] = deviceTransport.split('|');

      if (!transportToDeviceChannelsMap.has(transport as NexxusQueueName)) {
        transportToDeviceChannelsMap.set(transport as NexxusQueueName, new Map());
      }

      transportToDeviceChannelsMap.get(transport as NexxusQueueName)!.set(deviceId, Array.from(channelKeys));
    }

    for (const [transport, deviceChannelsMap] of transportToDeviceChannelsMap.entries()) {
      for (const [deviceId, channelKeys] of deviceChannelsMap.entries()) {
        this.publish(transport as NexxusQueueName, {
          event: 'device_message',
          deviceIds: [deviceId],
          data: {
            event: 'model_deleted',
            model: data,
            metadata: {
              channels: channelKeys
            }
          }
        });
      }

      NexxusTransportManagerWorker.logger.info(
        `Notifying ${deviceChannelsMap.size} devices about deleted model with ID: "${data.id}" via transport: "${transport}"`,
        {
          appId: data.appId,
          modelId: data.id,
          modelType: data.type,
          transport,
          deviceCount: deviceChannelsMap.size
        },
        NexxusTransportManagerWorker.loggerLabel
      );
    }
  }

  private async getDevicesFromGeneratedChannels<T>(channel: NexxusBaseSubscriptionChannel, change?: T | T[]): Promise<Map<NexxusDeviceTransportString, Set<string>>> {
    const deviceToChannelsMap = new Map<NexxusDeviceTransportString, Set<string>>();

    const app = NexxusTransportManagerWorker.loadedApps.get(channel.appId);

    if (!app) {
      NexxusTransportManagerWorker.logger.warn(
        `Application not found for appId: "${channel.appId}" when getting devices for channel: ${JSON.stringify(channel)}`,
        NexxusTransportManagerWorker.loggerLabel
      );

      return deviceToChannelsMap;
    }

    // Normalize change to array for consistent processing
    const changes = change !== undefined
      ? (Array.isArray(change) ? change : [change])
      : [];

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
            changesCount: changes.length
          },
          NexxusTransportManagerWorker.loggerLabel
        );
      }

      // If no changes (e.g., model deleted), skip filtered subscriptions
      if (changes) {
        const filters = await NexxusRedisSubscription.getAllFilters(channelPattern);

        // For each filter, test if ANY change matches
        for (const [filterId, filterQuery] of Object.entries(filters)) {
          const filter = new NexxusFilterQuery(filterQuery, app.getAppModelSchema(channelPattern.model));
          let matchesFilter = false;

          if (Array.isArray(changes)) {
            matchesFilter = (changes as Array<NexxusTransportManagerJsonPatch>).some(singleChange => {
              return filter.test(singleChange.metadata.partialModel);
            });
          } else {
            matchesFilter = filter.test(changes as Partial<INexxusAppModel>);
          }

          // Test if ANY change matches

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
                  changesCount: changes.length
                },
                NexxusTransportManagerWorker.loggerLabel
              );
            }
          }
        }
      }
    }

    NexxusTransportManagerWorker.logger.info(
      `Total ${deviceToChannelsMap.size} unique devices to notify for update`,
      {
        channel,
        size: deviceToChannelsMap.size
      },
      NexxusTransportManagerWorker.loggerLabel
    );

    return deviceToChannelsMap;
  }
}
