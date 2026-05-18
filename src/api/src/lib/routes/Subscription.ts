import { NexxusApiBaseRoute } from '../BaseRoute';
import {
  RequiredHeadersMiddleware,
  AppExistsMiddleware,
  AuthMiddleware
} from '../middlewares';
import {
  type NexxusApiRequest,
  type NexxusApiResponse,
  NexxusApi
} from '../Api';
import {
  InvalidParametersException,
  NotFoundException,
  ModelNotFoundException,
  DeviceNotConnectedException
} from '../Exceptions';
import {
  InvalidQueryFilterException,
  NexxusFilterQuery,
  NexxusFilterQueryType
} from '@mayhem93/nexxus-core-lib';
import {
  RedisKeyNotFoundException,
  NexxusRedisSubscription,
  NexxusDevice,
  RedisDeviceNotConnectedException
} from '@mayhem93/nexxus-redis';

import type { Router, RequestHandler } from 'express';

type SubscribeRequestBody = {
  model: string;
  userId?: string;
  id?: string;
  filter?: NexxusFilterQueryType;
  getOnly?: boolean;
  limit?: number;
  offset?: number;
};

type UnsubscribeRequestBody = Omit<SubscribeRequestBody, 'limit' | 'offset' | 'getOnly'>;

interface SubscribeRequest extends NexxusApiRequest {
  body: SubscribeRequestBody;
}

interface UnsubscribeRequest extends NexxusApiRequest {
  body: UnsubscribeRequestBody;
}

export default class SubscriptionRoute extends NexxusApiBaseRoute {
  constructor(appRouter: Router) {
    super('/subscription', appRouter);
  }

  protected registerRoutes(): void {
    this.router.use(
      RequiredHeadersMiddleware('nxx-app-id') as RequestHandler,
      RequiredHeadersMiddleware('nxx-device-id') as RequestHandler,
      AppExistsMiddleware() as RequestHandler,
      AuthMiddleware as RequestHandler
    );

    this.router.post('/', this.subscribe.bind(this) as RequestHandler);
    this.router.delete('/', this.unsubscribe.bind(this) as RequestHandler);
  }

  private async subscribe(req: SubscribeRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId);
    const appSchema = app!.getData().schema;
    const deviceId = req.headers['nxx-device-id'] as string;
    const responseBody: Record<string, any> = { data: {} };

    if (!req.body.model || typeof req.body.model !== 'string') {
      throw new InvalidParametersException('Invalid model parameter');
    }

    if (appSchema[req.body.model] === undefined) {
      throw new ModelNotFoundException(`Model "${req.body.model}" not found in application "${appId}"`);
    }

    if (typeof req.body.id !== 'string' && req.body.id !== undefined) {
      throw new InvalidParametersException('Invalid modelId parameter');
    }

    if (typeof req.body.userId !== 'string' && req.body.userId !== undefined) {
      throw new InvalidParametersException('Invalid userId parameter');
    } else if (NexxusApi.instance.getConfig().auth === undefined) {
      throw new InvalidParametersException('userId parameter cannot be used when authentication is disabled');
    }

    if (req.body.id !== undefined && req.body.userId !== undefined) {
      throw new InvalidParametersException('Redundant modelId and userId parameters provided');
    }

    if (req.body.limit === undefined) {
      req.body.limit = 10;
    } else {
      if (typeof req.body.limit !== 'number' || req.body.limit <= 0) {
        throw new InvalidParametersException('Invalid limit parameter');
      }
    }

    if (req.body.offset === undefined) {
      req.body.offset = 0;
    } else {
      if (typeof req.body.offset !== 'number' || req.body.offset < 0) {
        throw new InvalidParametersException('Invalid offset parameter');
      }
    }

    if (typeof req.body.getOnly !== 'boolean' && req.body.getOnly !== undefined) {
      throw new InvalidParametersException('Invalid getOnly parameter');
    }

    req.body.getOnly = req.body.getOnly || false;

    let subscriptionFilter: NexxusFilterQuery | undefined;

    if (req.body.filter !== undefined) {
      if (typeof req.body.filter !== 'object') {
        throw new InvalidParametersException('Invalid filter parameter');
      }

      try {
        subscriptionFilter = new NexxusFilterQuery(req.body.filter, NexxusApi.getStoredApp(appId)!.getAppModelSchema(req.body.model));
      } catch (e) {
        if (e instanceof InvalidQueryFilterException) {
          throw new InvalidParametersException(`Invalid filter parameter: ${e.message}`);
        }

        throw e;
      }
    }

    let databaseFilter: NexxusFilterQuery | undefined;

    //we merge "id" and "userId" queries to a db filter since these two are handled separately in the request
    if (req.body.filter !== undefined || req.body.id !== undefined || req.body.userId !== undefined) {
      const dbFilterInput: NexxusFilterQueryType = {
        ...structuredClone(req.body.filter || {}),
        ...(req.body.id && { id: req.body.id }),
        ...(req.body.userId && { userId: req.body.userId })
      };

      try {
        databaseFilter = new NexxusFilterQuery(dbFilterInput, NexxusApi.getStoredApp(appId)!.getAppModelSchema(req.body.model));
      } catch (e) {
        if (e instanceof InvalidQueryFilterException) {
          throw new InvalidParametersException(`Invalid filter parameter: ${e.message}`);
        }
        throw e;
      }
    }

    if (req.body.getOnly === false) {
      const sub = new NexxusRedisSubscription({
        appId,
        model: req.body.model,
        modelId: req.body.id,
        userId: req.body.userId,
        filter: subscriptionFilter
      });

      try {
        const device = await NexxusDevice.get(deviceId, true);

        await device.addSubscription(sub);

        responseBody.data.channelId = sub.getKey();
      } catch (e) {
        if (e instanceof RedisKeyNotFoundException) {
          throw new NotFoundException(`Device with id "${deviceId}" not found`);
        } else if (e instanceof RedisDeviceNotConnectedException) {
          throw new DeviceNotConnectedException(`Device with id "${deviceId}" is not connected to any transport`);
        }

        throw e;
      }
    }

    const results = (await NexxusApi.database.searchItems({
      appId,
      type: req.body.model,
      filter: databaseFilter,
      limit: req.body.limit,
      offset: req.body.offset,
      databaseSpecific: {
        forceRefresh: req.body.getOnly === false
      }
    })).map(item => item.getData());

    responseBody.data.items = results;

    res.status(200).send(responseBody);
  }

  private async unsubscribe(req: UnsubscribeRequest, res: NexxusApiResponse): Promise<void> {}
}
