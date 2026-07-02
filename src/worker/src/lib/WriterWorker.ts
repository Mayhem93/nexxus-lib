import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusConfig,
  NexxusQueueName,
  NexxusWriterPayload,
  NexxusAppModel,
  NexxusJsonPatch,
  NexxusBaseQueuePayload,
  NexxusTransportManagerJsonPatch,
  INexxusAppModel
} from '@mayhem93/nexxus-core-lib';
import { NexxusQueueMessage } from '@mayhem93/nexxus-message-queue-lib';
import {
  NexxusBaseWorker,
  NexxusBaseWorkerEvents,
  NexxusWorkerServices
} from "./BaseWorker";

import * as path from "node:path";

export type NexxusWriterWorkerConfig = NexxusConfig & {
  name: string;
  /** Class name of the logger service (see `NexxusApiConfig.logger`). */
  logger: string;
  /** Class name of the database adapter (see `NexxusApiConfig.database`). */
  database: string;
  /** Class name of the message-queue adapter (see `NexxusApiConfig.message_queue`). */
  message_queue: string;
}

type NexxusWriterWorkerEvents = NexxusBaseWorkerEvents & {
  message: [string];
};

export class NexxusWriterWorker extends NexxusBaseWorker<NexxusWriterWorkerConfig, NexxusWriterWorkerEvents, NexxusWriterPayload> {
  protected queueName : NexxusQueueName = 'writer';
  protected static loggerLabel: Readonly<string> = 'NxxWriterWorker';
  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];
  protected static schemaPath: string = path.join(__dirname, '../../src/schemas/writer-worker.schema.json');

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  protected async processMessage(msg: NexxusQueueMessage<NexxusWriterPayload>): Promise<void> {
    NexxusWriterWorker.logger.debug('Processing message', { payload: msg.payload }, NexxusWriterWorker.loggerLabel);

    const payload = msg.payload;

    switch (payload.event) {
      case "model_created": {
        const app = NexxusWriterWorker.loadedApps.get(payload.data.appId);

        if (!app) {
          throw new Error(`App not found for model_created: appId=${payload.data.appId}`);
        }

        const appModel = new NexxusAppModel(payload.data, app.getSchema());

        await NexxusWriterWorker.database.createItems([ appModel ]);

        NexxusWriterWorker.logger.info(`Model created with ID: "${payload.data.id}" for appId: "${payload.data.appId}"`, {
          appId: payload.data.appId,
          modelId: payload.data.id,
          modelType: payload.data.type
        }, NexxusWriterWorker.loggerLabel);

        this.publish('transport-manager', {
          event: 'model_created',
          data: appModel.getData(),
        });

        break;
      }

      case 'model_updated': {
        const validatedPatches: Array<NexxusTransportManagerJsonPatch> = [];

        for (const patchData of payload.data) {
          const app = NexxusWriterWorker.loadedApps.get(patchData.metadata.appId);
          const modelSchema = app!.getAppModelSchema(patchData.metadata.type);
          const jsonPatch = new NexxusJsonPatch(patchData);

          jsonPatch.validate(modelSchema);

          const updateUpdatedAtPatch = new NexxusJsonPatch({
            op: 'replace',
            path: ['updatedAt'],
            value: [Math.floor((new Date().getTime()) / 1000)],
            metadata: jsonPatch.get().metadata
          });

          updateUpdatedAtPatch.validate(modelSchema);

          const result = await NexxusWriterWorker.database.updateItems(
            [jsonPatch, updateUpdatedAtPatch],
            {
              returnFields: app?.getModelFilterableFields(patchData.metadata.type)
            }
          ) as Array<Partial<INexxusAppModel>>;

          if (!result[0]) {
            NexxusWriterWorker.logger.warn(
              `No item found to update for patch with appId ${patchData.metadata.appId} and id ${patchData.metadata.id}`,
              NexxusWriterWorker.loggerLabel
            );

            return ;
          }

          const transformedPatchData = jsonPatch.get();
          const transformedUpdatedAtPatchData = updateUpdatedAtPatch.get();

          delete transformedPatchData.metadata.pathFieldTypes; // Remove pathFieldTypes before sending to Transport Manager
          delete transformedUpdatedAtPatchData.metadata.pathFieldTypes;
          delete result[0].id; // Remove id from partialModel before sending to Transport Manager

          validatedPatches.push({
            ...transformedPatchData,
            metadata: {
              ...transformedPatchData.metadata,
              partialModel: result[0]
            }
          },
          { ...transformedUpdatedAtPatchData,
            metadata: {
              ...transformedUpdatedAtPatchData.metadata,
              partialModel: result[0]
            }
          });
        }

        NexxusWriterWorker.logger.info(`Model updated with ID: "${payload.data[0].metadata.id}" for appId: "${payload.data[0].metadata.appId}"`, {
          appId: payload.data[0].metadata.appId,
          modelId: payload.data[0].metadata.id,
          modelType: payload.data[0].metadata.type
        }, NexxusWriterWorker.loggerLabel);

        this.publish('transport-manager', {
          event: 'model_updated',
          data: validatedPatches,
        });

        break;
      }

      case 'model_deleted': {
        const app = NexxusWriterWorker.loadedApps.get(payload.data.appId);

        if (!app) {
          throw new Error(`App not found for model_deleted: appId=${payload.data.appId}`);
        }

        const appModel = new NexxusAppModel(payload.data as INexxusAppModel, app.getSchema());

        await NexxusWriterWorker.database.deleteItems([ appModel ]);

        NexxusWriterWorker.logger.info(`Model deleted with ID: "${payload.data.id}" for appId: "${payload.data.appId}"`, {
          appId: payload.data.appId,
          modelId: payload.data.id,
          modelType: payload.data.type
        }, NexxusWriterWorker.loggerLabel);

        this.publish('transport-manager', {
          event: 'model_deleted',
          data: payload.data,
        });

        break;
      }
      default:
        NexxusWriterWorker.logger.warn(`Unknown event type: ${(payload as NexxusBaseQueuePayload).event}`, NexxusWriterWorker.loggerLabel);
    }
  }
}
