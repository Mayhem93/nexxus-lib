import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusQueueName,
  NexxusWriterPayload,
  NexxusAppModel,
  NexxusJsonPatch,
  NexxusBaseQueuePayload,
  NexxusTransportManagerJsonPatch,
  INexxusAppModel,
  UnknownApplicationException
} from '@mayhem93/nexxus-core-lib';
import { NexxusQueueMessage } from '@mayhem93/nexxus-message-queue-lib';
import { NexxusModelFieldCache } from '@mayhem93/nexxus-redis';
import {
  NexxusBaseWorker,
  NexxusBaseWorkerEvents,
  NexxusBaseWorkerConfig,
  NexxusBaseWorkerStats,
  NexxusWorkerServices
} from './BaseWorker';
import { NexxusWorkerUnsupportedEventException } from './Exceptions';

import * as path from "node:path";

export type NexxusWriterWorkerConfig = NexxusBaseWorkerConfig & {
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

type NexxusWriterWorkerStats = NexxusBaseWorkerStats & {}

export class NexxusWriterWorker extends NexxusBaseWorker<
  NexxusWriterWorkerConfig,
  NexxusWriterWorkerEvents,
  NexxusWriterPayload,
  NexxusWriterWorkerStats
> {
  protected nodeRole: string = 'writer';
  protected queueName: NexxusQueueName = 'writer';
  protected static loggerLabel: Readonly<string> = 'NxxWriterWorker';
  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];
  protected static schemaPath: string = path.join(__dirname, '../../src/schemas/writer-worker.schema.json');

  /**
   * Read back from the database on updates and deletes, on apps with users:
   * their events name the record's owner, not whoever made the change.
   */
  private static readonly OWNER_FIELDS: ReadonlySet<string> = new Set([ 'userId' ]);

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
          throw new UnknownApplicationException(`App not found for model_created: appId=${payload.data.appId}`);
        }

        const appModel = new NexxusAppModel(payload.data, app.getSchema());

        await NexxusWriterWorker.database.createItems([ appModel ]);

        NexxusWriterWorker.logger.info(`Model created with ID: "${payload.data.id}" for appId: "${payload.data.appId}"`, {
          appId: payload.data.appId,
          modelId: payload.data.id,
          modelType: payload.data.type
        }, NexxusWriterWorker.loggerLabel);

        await this.publish('transport-manager', {
          event: 'model_created',
          data: appModel.getData(),
        });

        // Mirror the ACL field projection into the Redis field cache: the
        // always-cached builtins (id/userId/createdAt) plus any schema fields
        // flagged `acl: true`. Best-effort — the DB write already succeeded.
        if (app.isAclEnabled()) {
          const data = appModel.getData();
          const cacheFields: Record<string, unknown> = {
            id: data.id,
            createdAt: data.createdAt,
          };

          if (data.userId !== undefined) {
            cacheFields.userId = data.userId;
          }

          for (const field of app.getAclFields(data.type)) {
            if (data[field] !== undefined) {
              cacheFields[field] = data[field];
            }
          }

          await this.safeFieldCacheOp(
            () => new NexxusModelFieldCache(data.id as string, cacheFields).save(),
            `create cache for "${data.id}"`
          );
        }

        break;
      }

      case 'model_updated': {
        const validatedPatches: Array<NexxusTransportManagerJsonPatch> = [];

        for (const patchData of payload.data) {
          const app = NexxusWriterWorker.loadedApps.get(patchData.metadata.appId!);

          if (!app) {
            throw new UnknownApplicationException(`App not found for model_updated: appId=${patchData.metadata.appId}`);
          }

          const modelSchema = app.getAppModelSchema(patchData.metadata.type);
          const jsonPatch = new NexxusJsonPatch(patchData);

          jsonPatch.validate(modelSchema);

          const updateUpdatedAtPatch = new NexxusJsonPatch({
            op: 'replace',
            path: ['updatedAt'],
            value: [Math.floor((new Date().getTime()) / 1000)],
            metadata: jsonPatch.get().metadata
          });

          updateUpdatedAtPatch.validate(modelSchema);

          // ACL fields are added to returnFields so their post-write values
          // come back in the partial model and can be written through to the
          // field cache below (only when the app uses ACLs).
          const aclFields = app.isAclEnabled()
            ? app.getAclFields(patchData.metadata.type)
            : new Set<string>();
          const returnFields = new Set<string>([
            ...app.getModelFilterableFields(patchData.metadata.type),
            ...aclFields,
            ...(app.hasAuthEnabled() ? NexxusWriterWorker.OWNER_FIELDS : [])
          ]);

          const updated = (await NexxusWriterWorker.database.updateItems(
            [jsonPatch, updateUpdatedAtPatch],
            { returnFields }
          )).get(patchData.metadata.id) as Partial<INexxusAppModel> | null | undefined;

          if (!updated) {
            NexxusWriterWorker.logger.warn(
              `No item found to update for patch with appId ${patchData.metadata.appId} and id ${patchData.metadata.id}`,
              NexxusWriterWorker.loggerLabel
            );

            return ;
          }

          // Write-through the acl fields this patch actually touched. A partial
          // entry (e.g. after a TTL expiry) is fine — the read path backfills
          // missing builtins from the DB on the next cache miss.
          if (app.isAclEnabled() && aclFields.size > 0) {
            const patchedTopLevel = new Set(patchData.path.map(p => p.split('.')[0]));
            const changed: Record<string, unknown> = {};

            for (const field of aclFields) {
              if (patchedTopLevel.has(field) && updated[field] !== undefined) {
                changed[field] = updated[field];
              }
            }

            if (Object.keys(changed).length > 0) {
              await this.safeFieldCacheOp(
                () => new NexxusModelFieldCache(patchData.metadata.id, changed).save(),
                `update cache for "${patchData.metadata.id}"`
              );
            }
          }

          const transformedPatchData = jsonPatch.get();
          const transformedUpdatedAtPatchData = updateUpdatedAtPatch.get();

          delete transformedPatchData.metadata.pathFieldTypes; // Remove pathFieldTypes before sending to Transport Manager
          delete transformedUpdatedAtPatchData.metadata.pathFieldTypes;
          // The stored owner, which per-user channels are routed by — never a
          // `userId` the incoming patch carries.
          const userId = updated.userId;

          // The identity travels on `metadata`; `partialModel` keeps only the
          // rest of what was read back.
          delete updated.id;
          delete updated.userId;

          validatedPatches.push({
            ...transformedPatchData,
            metadata: {
              ...transformedPatchData.metadata,
              userId,
              partialModel: updated
            }
          },
          { ...transformedUpdatedAtPatchData,
            metadata: {
              ...transformedUpdatedAtPatchData.metadata,
              userId,
              partialModel: updated
            }
          });
        }

        NexxusWriterWorker.logger.info(`Model updated with ID: "${payload.data[0].metadata.id}" for appId: "${payload.data[0].metadata.appId}"`, {
          appId: payload.data[0].metadata.appId,
          modelId: payload.data[0].metadata.id,
          modelType: payload.data[0].metadata.type
        }, NexxusWriterWorker.loggerLabel);

        await this.publish('transport-manager', {
          event: 'model_updated',
          data: validatedPatches,
        });

        break;
      }

      case 'model_deleted': {
        const app = NexxusWriterWorker.loadedApps.get(payload.data.appId);

        if (!app) {
          throw new UnknownApplicationException(`App not found for model_deleted: appId=${payload.data.appId}`);
        }

        // Trusted path: a delete only needs id/appId/type to address the
        // document, so re-validating the whole payload against the schema
        // would add nothing and would reject an otherwise-valid delete whose
        // payload omits a required field.
        const appModel = NexxusAppModel.fromStorage(payload.data as INexxusAppModel);
        // Read back what the Transport Manager routes a delete by, as it was just
        // before the delete: the owner, for per-user channels, and the
        // filterable fields, for filtered subscriptions. A model nobody can
        // subscribe to needs neither, and costs no extra read.
        const returnFields = app.isSubscribable(payload.data.type)
          ? new Set<string>([
            ...app.getModelFilterableFields(payload.data.type),
            ...(app.hasAuthEnabled() ? NexxusWriterWorker.OWNER_FIELDS : [])
          ])
          : new Set<string>();
        const deleted = (await NexxusWriterWorker.database.deleteItems(
          [ appModel ],
          returnFields.size > 0 ? { returnFields } : {}
        )).get(payload.data.id as string) as Partial<INexxusAppModel> | null | undefined;

        // Already gone: the delete that got there first has told the subscribers.
        if (!deleted) {
          NexxusWriterWorker.logger.info(`Model with ID: "${payload.data.id}" for appId: "${payload.data.appId}" was already deleted, nothing to notify`, {
            appId: payload.data.appId,
            modelId: payload.data.id,
            modelType: payload.data.type
          }, NexxusWriterWorker.loggerLabel);

          return;
        }

        NexxusWriterWorker.logger.info(`Model deleted with ID: "${payload.data.id}" for appId: "${payload.data.appId}"`, {
          appId: payload.data.appId,
          modelId: payload.data.id,
          modelType: payload.data.type
        }, NexxusWriterWorker.loggerLabel);

        // The stored owner, which per-user channels are routed by — never a
        // `userId` the incoming delete carries.
        const userId = deleted.userId;

        // The identity travels on `data`; `partialModel` keeps only the rest of
        // what was read back.
        delete deleted.id;
        delete deleted.userId;

        await this.publish('transport-manager', {
          event: 'model_deleted',
          data: {
            id: payload.data.id,
            type: payload.data.type,
            appId: payload.data.appId,
            userId,
            partialModel: deleted
          },
        });

        if (app.isAclEnabled()) {
          await this.safeFieldCacheOp(
            () => NexxusModelFieldCache.remove(payload.data.id as string),
            `delete cache for "${payload.data.id}"`
          );
        }

        break;
      }
      default:
        throw new NexxusWorkerUnsupportedEventException(
          `The Writer doesn't handle "${(payload as NexxusBaseQueuePayload).event}" events`
        );
    }
  }

  /**
   * Run a field-cache mutation best-effort: the authoritative DB write has
   * already succeeded, so a Redis failure here is logged and swallowed rather
   * than failing the message (which would redeliver and re-run the DB write).
   */
  private async safeFieldCacheOp(op: () => Promise<void>, context: string): Promise<void> {
    try {
      await op();
    } catch (e) {
      NexxusWriterWorker.logger.warn(
        `Field cache op failed (${context}) — non-fatal: ${(e as Error).message}`,
        NexxusWriterWorker.loggerLabel
      );
    }
  }
}
