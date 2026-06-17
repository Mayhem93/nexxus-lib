import {
  NexxusApi,
  NexxusApiRequest,
  NexxusApiResponse,
  NexxusApiUser
} from '../Api';
import {
  UserAuthenticationFailedException,
  NoAuthPresentException,
  UserTokenExpiredException
} from '../Exceptions';

import jwt from 'jsonwebtoken';
import type { NextFunction } from 'express';

/**
 * Middleware: Require JWT authentication (for all protected routes)
 */
export default (req: NexxusApiRequest, res: NexxusApiResponse, next: NextFunction) => {
  const appId = req.headers['nxx-app-id'] as string;
  const app = NexxusApi.getStoredApp(appId);

  if (app?.getData().auth === undefined) {
    return next();
  }

  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    throw new NoAuthPresentException('No token provided');
  }

  // JWT signing secret is per-application (lives on `app.auth.jwtSecret`).
  // The NexxusApplication constructor guarantees this is present when
  // authEnabled is true, so reaching here without it implies a doc that
  // bypassed validation — surface as an authentication failure rather than
  // crashing the request.
  const jwtSecret = app.getData().auth?.jwtSecret;

  if (!jwtSecret) {
    throw new UserAuthenticationFailedException('Application is misconfigured for authentication');
  }

  try {
    req.user = jwt.verify(token, jwtSecret) as NexxusApiUser; // Attach user info to request

    next();
  } catch (e) {
    switch (e.name) {
      case 'TokenExpiredError':
        throw new UserTokenExpiredException('Token has expired');
      case 'JsonWebTokenError':
        throw new UserAuthenticationFailedException('Invalid token');
      default:
        throw e;
    }
  }
};
