import {
  InvalidQueryFilterException,
  NexxusApplication,
  NexxusFilterQuery,
  NexxusFilterQueryType,
} from '@mayhem93/nexxus-core-lib';

import { NexxusApi, type NexxusApiRequest } from './Api';
import {
  InvalidParametersException,
  ModelNotFoundException,
} from './Exceptions';

/**
 * The shared bits of "read-shaped" request validation across model-facing
 * routes (subscribe, unsubscribe, search, count). Every one of these takes
 * `{ model, id?, userId?, filter? }` in the request body, validates it
 * against the app's schema, and materializes a `NexxusFilterQuery` — this
 * function is the single implementation.
 *
 * Pagination (`limit` / `offset`) is deliberately NOT handled here — only
 * the search route uses it, so it stays inline there.
 */
export interface ValidatedModelQuery {
  appId: string;
  app: NexxusApplication;
  model: string;
  id?: string;
  userId?: string;
  /**
   * The caller's filter, validated + wrapped as a `NexxusFilterQuery`.
   * Does NOT include the id/userId merge — callers that want to search
   * the DB should build a separate "database filter" by folding id and
   * userId in; callers that only want a subscription filter (matching
   * against future updates) use this one as-is.
   */
  filter?: NexxusFilterQuery;
}

interface ModelQueryBody {
  id?: string;
  userId?: string;
  filter?: NexxusFilterQueryType;
}

/**
 * Validate the shared read-shaped request params and materialize the
 * `NexxusFilterQuery`. `model` is passed separately because different
 * routes source it from different places (URL param on search, body on
 * subscribe/unsubscribe).
 *
 * Throws `InvalidParametersException` / `ModelNotFoundException` on any
 * validation failure — routes let those propagate to the error middleware.
 */
export function validateModelQueryParams(
  req: NexxusApiRequest,
  body: ModelQueryBody,
  model: string,
): ValidatedModelQuery {
  const appId = req.headers['nxx-app-id'] as string;
  const app = NexxusApi.getStoredApp(appId)!;
  const appSchema = app.getData().schema;

  if (!model || typeof model !== 'string') {
    throw new InvalidParametersException('Invalid model parameter');
  }

  if (appSchema[model] === undefined) {
    throw new ModelNotFoundException(`Model "${model}" not found in application "${appId}"`);
  }

  if (typeof body.id !== 'string' && body.id !== undefined) {
    throw new InvalidParametersException('Invalid modelId parameter');
  }

  if (body.userId !== undefined) {
    if (typeof body.userId !== 'string') {
      throw new InvalidParametersException('Invalid userId parameter');
    }

    if (!app.hasAuthEnabled()) {
      throw new InvalidParametersException(
        'userId parameter cannot be used when authentication is disabled for this application',
      );
    }
  }

  if (body.id !== undefined && body.userId !== undefined) {
    throw new InvalidParametersException('Redundant modelId and userId parameters provided');
  }

  let filter: NexxusFilterQuery | undefined;

  if (body.filter !== undefined) {
    if (typeof body.filter !== 'object') {
      throw new InvalidParametersException('Invalid filter parameter');
    }

    try {
      filter = new NexxusFilterQuery(body.filter, app.getAppModelSchema(model));
    } catch (e) {
      if (e instanceof InvalidQueryFilterException) {
        throw new InvalidParametersException(`Invalid filter parameter: ${e.message}`);
      }

      throw e;
    }
  }

  return { appId, app, model, id: body.id, userId: body.userId, filter };
}

/**
 * Fold id + userId into a copy of the user's filter to produce the
 * database filter — separate from the subscription filter, which stays
 * user-provided so it matches only against the fields the client
 * actually cares about (not the framework-injected id/userId).
 *
 * Returns undefined when the caller supplied nothing (no filter, no id,
 * no userId) — the caller can then skip building a DB filter entirely.
 */
export function buildDatabaseFilter(
  validated: ValidatedModelQuery,
  rawFilter: NexxusFilterQueryType | undefined,
): NexxusFilterQuery | undefined {
  const { app, model, id, userId } = validated;

  if (rawFilter === undefined && id === undefined && userId === undefined) {
    return undefined;
  }

  const dbFilterInput: NexxusFilterQueryType = {
    ...structuredClone(rawFilter ?? {}),
    ...(id && { id }),
    ...(userId && { userId }),
  };

  try {
    return new NexxusFilterQuery(dbFilterInput, app.getAppModelSchema(model));
  } catch (e) {
    if (e instanceof InvalidQueryFilterException) {
      throw new InvalidParametersException(`Invalid filter parameter: ${e.message}`);
    }

    throw e;
  }
}
