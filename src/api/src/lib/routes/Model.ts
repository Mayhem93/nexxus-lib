import { InvalidParametersException, ModelNotFoundException } from '../Exceptions';
import { NexxusApiBaseRoute } from '../BaseRoute';
import { type NexxusApiRequest, type NexxusApiResponse, NexxusApi } from '../Api';
import { RequiredHeadersMiddleware, AppExistsMiddleware, AuthMiddleware } from '../middlewares';
import {
  NexxusAppModel,
  NexxusJsonPatch,
  type INexxusAppModel,
  type NexxusApplicationSchema,
  InvalidJsonPatchException,
  NexxusJsonPatchInternal
} from '@mayhem93/nexxus-core-lib';

import type { Router, RequestHandler } from 'express';

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

export default class ModelRoute extends NexxusApiBaseRoute {
  constructor(appRouter: Router) {
    super('/model', appRouter);
  }

  protected registerRoutes(): void {
    this.router.use(RequiredHeadersMiddleware('nxx-app-id') as RequestHandler);
    this.router.use(RequiredHeadersMiddleware('nxx-device-id') as RequestHandler);
    this.router.use(AppExistsMiddleware() as RequestHandler);
    this.router.use(AuthMiddleware as RequestHandler);

    this.router.post('/', this.createModel.bind(this) as RequestHandler);
    this.router.get('/:id', this.getModel.bind(this) as RequestHandler<GetModelRequest['params'], any, any, GetModelRequest['query']>);
    this.router.put('/:id', this.updateModel.bind(this) as RequestHandler<UpdateAppModelRequest['params'], any, UpdateAppModelRequest['body']>);
    this.router.delete('/:id', this.deleteModel.bind(this) as RequestHandler<DeleteAppModelRequest['params']>);
  }

  private async getModel(req: GetModelRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const appSchema = NexxusApi.getStoredApp(appId)?.getSchema() as NexxusApplicationSchema;

    if (!req.query.type) {
      throw new InvalidParametersException('Query parameter "type" is required');
    }

    if (!appSchema[req.query.type]) {
      throw new ModelNotFoundException(`Model "${req.query.type}" not found in schema for the application "${appId}"`);
    }

    const items = await NexxusApi.database.getItems({
      ids: [ req.params.id ],
      type: req.query.type,
      appId: appId
    });

    if (items.length === 0 || !items[0]) {
      throw new ModelNotFoundException(`Model instance with ID "${req.params.id}" not found`);
    }

    res.status(200).send({ data: items[0].getData() });
  }

  private async createModel(req: CreateAppModelRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const appSchema = NexxusApi.getStoredApp(appId)?.getSchema() as NexxusApplicationSchema;

    if (!appSchema[req.body.type]) {
      throw new ModelNotFoundException(`Model "${req.body.type}" not found in schema for the application "${appId}"`);
    }

    const newModel = new NexxusAppModel({
      ...req.body,
      appId: appId,
      userId: req.user?.id
    });

    await NexxusApi.messageQueue.publishMessage('writer', { event: 'model_created', data: newModel.getData() });

    res.status(202).send({ message: 'Model created successfully!' });
  }

  private async updateModel(req: UpdateAppModelRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const appSchema = NexxusApi.getStoredApp(appId)?.getSchema() as NexxusApplicationSchema;

    if (!appSchema[req.body.type]) {
      throw new ModelNotFoundException(`Model "${req.body.type}" not found in schema for the application "${appId}"`);
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
    const appSchema = NexxusApi.getStoredApp(appId)?.getSchema() as NexxusApplicationSchema;

    if (!appSchema[req.body.type]) {
      throw new ModelNotFoundException(`Model "${req.body.type}" not found in schema for the application "${appId}"`);
    }

    await NexxusApi.messageQueue.publishMessage('writer', { event: 'model_deleted', data: {
      appId,
      id: req.params.id,
      type: req.body.type,
      userId: req.user?.id
    }});

    res.status(202).send({ message: 'Model deleted successfully!' });
  }
}
