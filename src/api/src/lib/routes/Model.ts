import { InvalidParametersException, ModelNotFoundException } from '../Exceptions';
import { NexxusApiBaseRoute } from '../BaseRoute';
import { type NexxusApiRequest, type NexxusApiResponse, NexxusApi } from '../Api';
import { RequiredHeadersMiddleware, AppExistsMiddleware, AuthMiddleware } from '../middlewares';
import { validateModelQueryParams, buildDatabaseFilter } from '../ModelQueryValidation';
import { authorizeAcl, enforceRowConstraint, loadObjectAttributes } from '../Acl';
import {
  NexxusAppModel,
  NexxusJsonPatch,
  type INexxusAppModel,
  InvalidJsonPatchException,
  NexxusJsonPatchInternal,
  NexxusFilterQueryType,
  NexxusFilterQuery,
  InvalidQueryFilterException
} from '@mayhem93/nexxus-core-lib';

import type { Router, RequestHandler } from 'express';

type SearchModelRequestBody = {
  id?: string;
  userId?: string;
  filter?: NexxusFilterQueryType;
  limit?: number;
  offset?: number;
};

interface SearchModelRequest extends NexxusApiRequest {
  body: SearchModelRequestBody;
  params: {
    type: string;
  };
}

interface GetModelRequest extends NexxusApiRequest {
  params: {
    id: string;
  };
  query: {
    type?: string;
  }
}

interface CreateAppModelRequest extends NexxusApiRequest {
  body: INexxusAppModel;
}

type UpdateAppModelBody = {
  type: string;
  patch: Omit<NexxusJsonPatchInternal, 'metadata'>;
}

interface UpdateAppModelRequest extends NexxusApiRequest {
  body: UpdateAppModelBody;
  params: {
    id: string;
  }
}

type DeleteAppModelBody = {
  type: string;
}

interface DeleteAppModelRequest extends NexxusApiRequest {
  body: DeleteAppModelBody;
  params: {
    id: string;
  }
}

type CountModelRequestBody = {
  type: string;
  userId?: string;
  filter?: NexxusFilterQueryType;
}

interface CountModelRequest extends NexxusApiRequest {
  body: CountModelRequestBody;
}

export default class ModelRoute extends NexxusApiBaseRoute {
  constructor(appRouter: Router) {
    super('/model', appRouter);
  }

  protected registerRoutes(): void {
    this.router.use(RequiredHeadersMiddleware('nxx-app-id') as RequestHandler);
    // this.router.use(RequiredHeadersMiddleware('nxx-device-id') as RequestHandler);
    this.router.use(AppExistsMiddleware() as RequestHandler);
    this.router.use(AuthMiddleware as RequestHandler);

    this.router.post('/', this.createModel.bind(this) as RequestHandler);
    this.router.get('/:id',
      this.getModel.bind(this) as RequestHandler<GetModelRequest['params'], any, any, GetModelRequest['query']>
    );
    this.router.put('/:id',
      this.updateModel.bind(this) as RequestHandler<UpdateAppModelRequest['params'], any, UpdateAppModelRequest['body']>
    );
    this.router.delete('/:id',
      this.deleteModel.bind(this) as RequestHandler<DeleteAppModelRequest['params']>
    );
    this.router.post('/count',
      this.countModel.bind(this) as RequestHandler<any, any, CountModelRequestBody>
    );
    this.router.post('/:type/search',
      this.searchModel.bind(this) as RequestHandler<SearchModelRequest['params'], any, SearchModelRequest['body']>
    );
  }

  /**
   * Traditional search — no subscription side-effect. Model type comes
   * from the URL param; filter / pagination / id / userId from the body.
   * Shared validation with subscribe/unsubscribe lives in
   * `ModelQueryValidation.validateModelQueryParams`.
   */
  private async searchModel(req: SearchModelRequest, res: NexxusApiResponse): Promise<void> {
    const validated = validateModelQueryParams(req, req.body, req.params.type);
    const { appId, app, model } = validated;

    const aclConstraint = authorizeAcl(app, req, 'search', model);

    // Pagination — kept inline because only this route uses it.
    let limit = req.body.limit;

    if (limit !== undefined && (typeof limit !== 'number' || limit <= 0)) {
      throw new InvalidParametersException('Invalid limit parameter');
    }

    limit = limit ?? app.getData().defaultLimit;

    if (limit! > app.getData().maxLimit!) {
      throw new InvalidParametersException(`Limit parameter exceeds maximum allowed value (${app.getData().maxLimit})`);
    }

    let offset = req.body.offset;

    if (offset === undefined) {
      offset = 0;
    } else if (typeof offset !== 'number' || offset < 0) {
      throw new InvalidParametersException('Invalid offset parameter');
    }

    const databaseFilter = buildDatabaseFilter(validated, req.body.filter, aclConstraint ?? undefined);

    const results = (await NexxusApi.database.searchItems({
      appId,
      type: model,
      filter: databaseFilter,
      limit,
      offset,
    })).map(item => item.getData());

    res.status(200).send({ data: { items: results } });
  }

  private async getModel(req: GetModelRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId)!;
    const appSchema = app.getSchema();

    if (!req.query.type) {
      throw new InvalidParametersException('Query parameter "type" is required');
    }

    if (!appSchema[req.query.type]) {
      throw new ModelNotFoundException(`Model "${req.query.type}" not found in schema for the application "${appId}"`);
    }

    const aclConstraint = authorizeAcl(app, req, 'get', req.query.type);

    const items = await NexxusApi.database.getItems({
      ids: [ req.params.id ],
      type: req.query.type,
      appId: appId
    });

    if (items.length === 0 || !items[0]) {
      throw new ModelNotFoundException(`Model instance with ID "${req.params.id}" not found`);
    }

    enforceRowConstraint(app, req, 'get', req.query.type, aclConstraint, items[0].getData() as Record<string, unknown>);

    res.status(200).send({ data: items[0].getData() });
  }

  private async createModel(req: CreateAppModelRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId)!;
    const appSchema = app.getSchema();

    if (!appSchema[req.body.type]) {
      throw new ModelNotFoundException(`Model "${req.body.type}" not found in schema for the application "${appId}"`);
    }

    const aclConstraint = authorizeAcl(app, req, 'create', req.body.type);

    const newModel = new NexxusAppModel({
      ...req.body,
      appId: appId,
      userId: req.user?.id
    }, appSchema);

    // The created object must itself satisfy the row condition (e.g. a role
    // that may only create objects it owns) — checked against the new data.
    enforceRowConstraint(app, req, 'create', req.body.type, aclConstraint, newModel.getData() as Record<string, unknown>);

    // Transient models bypass the writer entirely — their records are
    // notification-shaped, existing only long enough to fan out to
    // subscribers. Publishing directly to transport-manager saves the
    // DB write and the writer's re-validate hop. The payload shape is
    // identical (both queues accept NexxusModelCreatedPayload).
    if (app.isTransient(req.body.type)) {
      await NexxusApi.messageQueue.publishMessage('transport-manager', {
        event: 'model_created',
        data: newModel.getData(),
      });
    } else {
      await NexxusApi.messageQueue.publishMessage('writer', {
        event: 'model_created',
        data: newModel.getData(),
      });
    }

    res.status(202).send({ message: 'Model created successfully!' });
  }

  private async updateModel(req: UpdateAppModelRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId)!;
    const appSchema = app.getSchema();

    if (!appSchema[req.body.type]) {
      throw new ModelNotFoundException(`Model "${req.body.type}" not found in schema for the application "${appId}"`);
    }

    if (app.isTransient(req.body.type)) {
      throw new InvalidParametersException(
        `Model "${req.body.type}" is transient (create-only) and cannot be updated`
      );
    }

    const aclConstraint = authorizeAcl(app, req, 'update', req.body.type);

    if (aclConstraint) {
      const attrs = await loadObjectAttributes(appId, req.body.type, req.params.id);

      enforceRowConstraint(app, req, 'update', req.body.type, aclConstraint, attrs);
    }

    try {
      const jsonPatch = new NexxusJsonPatch({
        ...req.body.patch,
        metadata: {
          appId,
          id: req.params.id,
          type: req.body.type,
          userId: req.user?.id
        }
      });

      jsonPatch.validate(NexxusApi.getStoredApp(appId)!.getAppModelSchema(req.body.type));

      await NexxusApi.messageQueue.publishMessage('writer', { event: 'model_updated', data: [ jsonPatch.get() ] });

      res.status(202).send({ message: 'Model updated successfully!' });
    } catch (error) {
      if (error instanceof InvalidJsonPatchException) {
        throw new InvalidParametersException(`Invalid JSON Patch: ${error.message}`);
      }

      throw error;
    }
  }

  private async deleteModel(req: DeleteAppModelRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId)!;
    const appSchema = app.getSchema();

    if (!appSchema[req.body.type]) {
      throw new ModelNotFoundException(`Model "${req.body.type}" not found in schema for the application "${appId}"`);
    }

    if (app.isTransient(req.body.type)) {
      throw new InvalidParametersException(
        `Model "${req.body.type}" is transient (create-only) and cannot be deleted`
      );
    }

    const aclConstraint = authorizeAcl(app, req, 'delete', req.body.type);

    if (aclConstraint) {
      const attrs = await loadObjectAttributes(appId, req.body.type, req.params.id);

      enforceRowConstraint(app, req, 'delete', req.body.type, aclConstraint, attrs);
    }

    await NexxusApi.messageQueue.publishMessage('writer', { event: 'model_deleted', data: {
      appId,
      id: req.params.id,
      type: req.body.type,
      userId: req.user?.id
    }});

    res.status(202).send({ message: 'Model deleted successfully!' });
  }

  private async countModel(req: CountModelRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId)!;
    const appSchema = app.getSchema();

    if (!appSchema[req.body.type]) {
      throw new ModelNotFoundException(`Model "${req.body.type}" not found in schema for the application "${appId}"`);
    }

    // Count is gated at the action level only — row conditions don't apply
    // (a full count, per the ACL design).
    authorizeAcl(app, req, 'count', req.body.type);

    let databaseFilter: NexxusFilterQuery | undefined;

    //we merge "id" and "userId" queries to a db filter since these two are handled separately in the request
    if (req.body.filter !== undefined || req.body.userId !== undefined) {
      const dbFilterInput: NexxusFilterQueryType = {
        ...structuredClone(req.body.filter || {}),
        ...(req.body.userId && { userId: req.body.userId })
      };

      try {
        databaseFilter = new NexxusFilterQuery(dbFilterInput, NexxusApi.getStoredApp(appId)!.getAppModelSchema(req.body.type));
      } catch (e) {
        if (e instanceof InvalidQueryFilterException) {
          throw new InvalidParametersException(`Invalid filter parameter: ${e.message}`);
        }
        throw e;
      }
    }

    const count = await NexxusApi.database.countItems({
      type: req.body.type,
      appId: appId,
      filter: databaseFilter
    });

    res.status(200).send({ data: { count } });
  }
}
