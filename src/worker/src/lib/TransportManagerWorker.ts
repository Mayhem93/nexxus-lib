import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusConfig,
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
  NexxusWorkerServices
} from "./BaseWorker";

import * as path from "node:path";

type NexxusTransportManagerWorkerConfig = NexxusConfig & {
  name: string;
}

type NexxusTransportManagerWorkerEvents = NexxusBaseWorkerEvents & {
  message: [string];
}

export class NexxusTransportManagerWorker extends NexxusBaseWorker<NexxusTransportManagerWorkerConfig, NexxusTransportManagerWorkerEvents, NexxusTransportManagerPayload> {
  protected queueName : NexxusQueueName = "transport-manager";
  protected static loggerLabel: Readonly<string> = "NxxTransportManagerWorker";
  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];
  protected static schemaPath: string = path.join(__dirname, "../../src/schemas/transport-manager-worker.schema.json");

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  protected async processMessage(msg: NexxusQueueMessage<NexxusTransportManagerPayload>): Promise<void> {
    NexxusTransportManagerWorker.logger.debug('Processing message', { payload: msg.payload }, NexxusTransportManagerWorker.loggerLabel);

    const payload = msg.payload;

    switch (payload.event) {
      case "model_created":
        await this.handleModelCreated(payload.data);

        break;
      case "model_updated":
        await this.handleModelUpdated(payload.data);

        NexxusTransportManagerWorker.logger.debug('Processing model update', { data: payload.data }, NexxusTransportManagerWorker.loggerLabel);

        break;

      case "model_deleted":
        await this.handleModelDeleted(payload.data);

        NexxusTransportManagerWorker.logger.debug('Processing model delete', { data: payload.data }, NexxusTransportManagerWorker.loggerLabel);

        break;
      default:
        NexxusTransportManagerWorker.logger.warn(`Unknown event type: ${(payload as NexxusBaseQueuePayload).event}`, NexxusTransportManagerWorker.loggerLabel);
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

      NexxusTransportManagerWorker.logger.debug(
        `Notifying ${deviceChannelsMap.size} devices about new model with ID: "${data.id}" via transport: "${transport}"`,
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
    const modelIdentity = {
      id: data[0].metadata.id,
      type: data[0].metadata.type,
      appId: data[0].metadata.appId,
      userId: data[0].metadata.userId,
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

      NexxusTransportManagerWorker.logger.debug(
        `Notified ${deviceChannelsMap.size} devices about update to model ID: "${data[0].metadata.id}" via transport: "${transport}"`,
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

      NexxusTransportManagerWorker.logger.debug(
        `Notifying ${deviceChannelsMap.size} devices about deleted model with ID: "${data.id}" via transport: "${transport}"`,
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

    // Step 1: Generate all base channels (without filters)
    const baseChannels = NexxusRedisSubscription.generateSubscriptionPatterns(channel);

    for (const channelPattern of baseChannels) {
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

      NexxusTransportManagerWorker.logger.debug(
        `Found ${unfilteredDevices.size} devices for unfiltered channel: ${unfilteredChannelKey}`,
        NexxusTransportManagerWorker.loggerLabel
      );

      // If no changes (e.g., model deleted), skip filtered subscriptions
      if (changes) {
        const filters = await NexxusRedisSubscription.getAllFilters(channelPattern);

        // Step 3: For each filter, test if ANY change matches
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

            NexxusTransportManagerWorker.logger.debug(
              `Found ${filteredDevices.size} devices for filtered channel: ${filteredChannelKey}`,
              NexxusTransportManagerWorker.loggerLabel
            );
          }
        }
      }
    }

    NexxusTransportManagerWorker.logger.debug(
      `Total ${deviceToChannelsMap.size} unique devices to notify for update`,
      NexxusTransportManagerWorker.loggerLabel
    );

    return deviceToChannelsMap;
  }
}
