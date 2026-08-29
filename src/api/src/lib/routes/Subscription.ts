import { NexxusApiBaseRoute } from '../BaseRoute';
import {
  RequiredHeadersMiddleware,
  AppExistsMiddleware,
  AuthMiddleware
} from '../middlewares';
import {
  type NexxusApiRequest,
  type NexxusApiResponse,
  NexxusApi,
} from '../Api';
import {
  InvalidParametersException,
  NotFoundException,
  DeviceNotConnectedException
} from '../Exceptions';
import { validateModelQueryParams, buildDatabaseFilter } from '../ModelQueryValidation';
import { authorizeAcl, withAclFilter } from '../Acl';

import { NexxusFilterQueryType } from '@mayhem93/nexxus-core-lib';
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
  limit?: number;
  offset?: number;
};

type UnsubscribeRequestBody = Omit<SubscribeRequestBody, 'limit' | 'offset'>;

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

    // ACL enforcement for subscribe/unsubscribe is wired inside the handlers
    // (step 3) so it can inject the row constraint into the subscription.
    this.router.post('/', this.subscribe.bind(this) as RequestHandler);
    this.router.delete('/', this.unsubscribe.bind(this) as RequestHandler);
  }

  private async subscribe(req: SubscribeRequest, res: NexxusApiResponse): Promise<void> {
    const deviceId = req.headers['nxx-device-id'] as string;

    const validated = validateModelQueryParams(req, req.body, req.body.model);
    const { appId, app, model, id, userId, filter } = validated;

    if (!app.isSubscribable(model)) {
      throw new InvalidParametersException(
        `Model "${model}" is not subscribable — use the search endpoint (POST /model/${model}/search) instead`
      );
    }

    const aclConstraint = authorizeAcl(app, req, 'subscribe', model);
    // Fold the row constraint into the stored subscription so the transport
    // manager (ACL-agnostic) only ever matches rows this principal may read.
    const effectiveFilter = aclConstraint ? withAclFilter(app, model, req.body.filter, aclConstraint) : filter;

    // Pagination — kept inline (only routes returning items use it).
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

    const sub = new NexxusRedisSubscription({
      appId,
      model,
      modelId: id,
      userId,
      filter: effectiveFilter,
    });

    try {
      const device = await NexxusDevice.get(deviceId, true);

      await device.addSubscription(sub);
    } catch (e) {
      if (e instanceof RedisKeyNotFoundException) {
        throw new NotFoundException(`Device with id "${deviceId}" not found`);
      } else if (e instanceof RedisDeviceNotConnectedException) {
        throw new DeviceNotConnectedException(`Device with id "${deviceId}" is not connected to any transport`);
      }

      throw e;
    }

    // Atomic subscribe + return initial data. `forceRefresh` matches the
    // previous getOnly=false behavior — we've just recorded a subscription
    // and want the initial page to be consistent with any in-flight writes.
    const databaseFilter = buildDatabaseFilter(validated, req.body.filter, aclConstraint ?? undefined);

    const results = (await NexxusApi.database.searchItems({
      appId,
      type: model,
      filter: databaseFilter,
      limit,
      offset,
      databaseSpecific: {
        forceRefresh: true,
      },
    })).map(item => item.getData());

    res.status(200).send({ data: { channelId: sub.getKey(), items: results } });
  }

  private async unsubscribe(req: UnsubscribeRequest, res: NexxusApiResponse): Promise<void> {
    const deviceId = req.headers['nxx-device-id'] as string;

    const validated = validateModelQueryParams(req, req.body, req.body.model);
    const { appId, app, model, id, userId, filter } = validated;

    if (!app.isSubscribable(model)) {
      throw new InvalidParametersException(
        `Model "${model}" is not subscribable — nothing to unsubscribe from`
      );
    }

    // Reconstruct the SAME effective filter subscribe stored (client filter AND
    // ACL constraint) — the channel key is derived from it, so we must fold the
    // constraint in the same way to find the record. Gated by the same
    // `subscribe` permission the subscription required.
    const aclConstraint = authorizeAcl(app, req, 'subscribe', model);
    const effectiveFilter = aclConstraint ? withAclFilter(app, model, req.body.filter, aclConstraint) : filter;

    // Rebuild the same descriptor the SDK used at subscribe time — the resulting
    // Redis key is derived deterministically from these fields, so matching
    // inputs find the same subscription record.
    const sub = new NexxusRedisSubscription({
      appId,
      model,
      modelId: id,
      userId,
      filter: effectiveFilter,
    });

    let removed: boolean;

    try {
      const device = await NexxusDevice.get(deviceId, true);

      removed = await device.removeSubscription(sub);
    } catch (e) {
      if (e instanceof RedisKeyNotFoundException) {
        throw new NotFoundException(`Device with id "${deviceId}" not found`);
      } else if (e instanceof RedisDeviceNotConnectedException) {
        throw new DeviceNotConnectedException(`Device with id "${deviceId}" is not connected to any transport`);
      }

      throw e;
    }

    if (!removed) {
      throw new NotFoundException(`Subscription "${sub.getKey()}" not found on device "${deviceId}"`);
    }

    res.status(200).json({ data: { channel: sub.getKey() } });
  }
}
