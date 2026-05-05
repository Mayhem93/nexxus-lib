import { NexxusApiBaseRoute } from '../BaseRoute';
import {
  type NexxusApiRequest,
  type NexxusApiResponse,
  NexxusApi
} from '../Api';
import {
  type INexxusApplication,
  NexxusApplication
} from '@mayhem93/nexxus-core-lib';

import type { Router, RequestHandler } from 'express';

interface CreateApplicationRequest extends NexxusApiRequest {
  body: Pick<INexxusApplication, "name" | "description" | "schema">;
}

export default class ApplicationRoute extends NexxusApiBaseRoute {
  constructor(appRouter: Router) {
    super('/application', appRouter);
  }

  protected registerRoutes(): void {
    /* this.router.post('/', this.createApp.bind(this)); */
    this.router.get('/:appId',  this.getApp.bind(this) as RequestHandler);
    this.router.put('/:appId', this.updateApp.bind(this) as RequestHandler);
  }

  private async getApp(req: NexxusApiRequest, res: NexxusApiResponse): Promise<void> {
    res.status(200).send({ message: 'Welcome to the Application Route!' });
  }

  /* private async createApp(req: CreateApplicationRequest, res: NexxusApiResponse): Promise<void> {
    if (!req.body.schema || typeof req.body.schema !== 'object') {
      throw new InvalidParametersException('Invalid or missing schema in request body');
    }

    const newApp = new NexxusApplication(req.body as INexxusApplication);

    await NexxusApi.messageQueue.publishMessage('writer', { data: newApp.getData(), event: 'app_created' });

    res.status(202).send({ message: 'Application created successfully!' });
  } */

  private async updateApp(req: NexxusApiRequest, res: NexxusApiResponse): Promise<void> {
    res.status(202).send({ message: 'Application updated successfully!' });
  }
}
