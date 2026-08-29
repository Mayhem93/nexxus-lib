import {
  NexxusApplication,
  NexxusAclManager,
  NexxusFilterQuery,
  type NexxusAclAction,
  type NexxusFilterQueryType,
} from '@mayhem93/nexxus-core-lib';
import { NexxusModelFieldCache } from '@mayhem93/nexxus-redis';

import { NexxusApi, type NexxusApiRequest } from './Api';
import { AccessDeniedException } from './Exceptions';

/**
 * ACL enforcement helpers used by the model/subscription route handlers. They
 * run AFTER request validation (unlike a pre-route middleware) so they can see
 * the resolved model, target id, and incoming body — everything a row/action
 * decision needs.
 *
 * Field-level rules don't exist (by design — model sensitive fields as their
 * own model), so enforcement is purely: (a) is the action allowed on the
 * model, and (b) does the object satisfy the row constraint. Every denial —
 * RBAC or row — surfaces as `AccessDeniedException` (403) plus an info log
 * naming the reason, which is easier to debug than a silent "not found".
 */

const ACL_LOG_LABEL = 'NxxApiAcl';

function logAndDeny(req: NexxusApiRequest, action: NexxusAclAction, model: string, reason: string): never {
  NexxusApi.logger.info(
    `ACL deny: ${action} "${model}" — user "${req.user?.id ?? 'anonymous'}" ` +
    `(userType "${req.user?.userType ?? 'default'}"): ${reason}`,
    ACL_LOG_LABEL,
  );

  throw new AccessDeniedException();
}

/**
 * Authorize `action` on `model` for the request principal (RBAC level).
 *
 * Returns `null` when the app has ACLs disabled (zero overhead) or when the
 * grant carries no row restriction. Returns a row-constraint filter when the
 * grant is conditional — callers fold it into the DB query (`search`) via
 * `buildDatabaseFilter`, or hand it to `enforceRowConstraint` for a single
 * object (`get`/`create`/`update`/`delete`).
 *
 * Throws `AccessDeniedException` (403) when no role grants the action.
 */
export function authorizeAcl(
  app: NexxusApplication,
  req: NexxusApiRequest,
  action: NexxusAclAction,
  model: string,
): NexxusFilterQueryType | null {
  if (!app.isAclEnabled()) {
    return null;
  }

  const userType = req.user?.userType ?? 'default';

  const result = NexxusAclManager.resolve(app, userType, action, model, {
    userId: req.user?.id,
    userType,
    appId: app.getData().id as string,
  });

  if (!result.allowed) {
    logAndDeny(req, action, model, 'no granted role allows this action on the model');
  }

  return result.constraint;
}

/**
 * Enforce a row constraint against a single object's attributes. No-op when
 * the constraint is `null` (unrestricted grant). A `null` `data` (object not
 * found) or a failing match both deny — with an info log naming which.
 */
export function enforceRowConstraint(
  app: NexxusApplication,
  req: NexxusApiRequest,
  action: NexxusAclAction,
  model: string,
  constraint: NexxusFilterQueryType | null,
  data: Record<string, unknown> | null,
): void {
  if (!constraint) {
    return;
  }

  if (data === null) {
    logAndDeny(req, action, model, 'target object not found');
  }

  const matches = new NexxusFilterQuery(constraint, app.getAppModelSchema(model)).test(data);

  if (!matches) {
    logAndDeny(req, action, model, 'object does not satisfy the row condition');
  }
}

/**
 * Load the condition-key attributes for an existing object so a write
 * (`update`/`delete`) can be row-checked without a full read path. Prefers the
 * Redis field cache (populated by the writer for ACL apps); falls back to a DB
 * get on a cache miss. Returns `null` when the object doesn't exist.
 */
export async function loadObjectAttributes(
  appId: string,
  model: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const cached = await NexxusModelFieldCache.get(id);

  if (cached) {
    return cached;
  }

  const items = await NexxusApi.database.getItems({ ids: [id], type: model, appId });

  return items.length > 0 && items[0] ? items[0].getData() as Record<string, unknown> : null;
}

/**
 * Build the effective subscription filter = the client's filter AND the ACL
 * row constraint. Folding the constraint into the stored subscription is what
 * keeps the transport manager ACL-agnostic (Path 1): it just matches this
 * filter and never sees rows the principal may not read. Both subscribe and
 * unsubscribe call this with the same inputs so they derive the same channel
 * key.
 *
 * NOTE (perf): for the common `userId == $nxx:userId` case this produces a
 * per-user filter rather than riding the existing userId subscription scope,
 * which the TM's filter registry can't dedupe. Fine at demo scale; a later
 * optimization can special-case pure userId-ownership onto the scope.
 */
export function withAclFilter(
  app: NexxusApplication,
  model: string,
  clientFilter: NexxusFilterQueryType | undefined,
  aclConstraint: NexxusFilterQueryType,
): NexxusFilterQuery {
  const combined: NexxusFilterQueryType = clientFilter
    ? { $and: [ clientFilter, aclConstraint ] }
    : aclConstraint;

  return new NexxusFilterQuery(combined, app.getAppModelSchema(model));
}
