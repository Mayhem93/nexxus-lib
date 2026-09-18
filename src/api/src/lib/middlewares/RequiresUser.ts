import { NexxusApiRequest } from '../Api';
import { InvalidAuthMethodException } from '../Exceptions';

import { type NextFunction, type Response } from 'express';

/**
 * Middleware: require an authenticated principal, for routes whose subject IS
 * the current user (`/user/me`, `PUT /user`, `/device/list`).
 *
 * `AuthMiddleware` can't fold this in. It has to let tokenless requests through
 * so the endpoints that MINT tokens can work at all — `/user/register`, and
 * `/device/register` on an application with no authentication — so "does this
 * route need a principal?" is route policy, not token policy.
 *
 * Wire it AFTER `AuthMiddleware`. Reaching here with no user means the
 * application has no authentication at all: where auth IS enabled,
 * `AuthMiddleware` has already rejected anything that failed to produce one.
 *
 * Checks `req.user?.id` rather than asking the application whether auth is
 * enabled, because that's the value the handlers actually dereference — it
 * stays correct for a token that carries a device but no user.
 */
export default (req: NexxusApiRequest, res: Response, next: NextFunction) => {
  if (!req.user?.id) {
    throw new InvalidAuthMethodException(
      'This endpoint requires an authenticated user, but authentication is not enabled for this application'
    );
  }

  next();
};
