import {
  NexxusApi,
  NexxusApiRequest,
  NexxusApiResponse
} from '../Api';
import {
  UserAuthenticationFailedException,
  NoAuthPresentException,
  UserTokenExpiredException,
  ApplicationNotFoundException
} from '../Exceptions';

import {
  NexxusToken,
  TokenExpiredException,
  InvalidTokenException
} from '@mayhem93/nexxus-core-lib';

import type { NextFunction } from 'express';

/**
 * Middleware: verify the bearer token and attach what it proves.
 *
 * Applications with and without authentication both issue tokens — the former
 * carry a user and a device, the latter only a device — so there is one
 * verification path rather than a separate mechanism per app flavour.
 *
 * A token is not demanded unconditionally, because the endpoints that MINT one
 * can't require one: `/user/register`, `/auth/<strategy>` and a first
 * `/device/register` all run before the caller has anything to present. The
 * rule is therefore:
 *
 *   - token present   → verify it and populate `req.user` / `req.deviceId`
 *   - token absent    → allowed only for an app with no authentication
 *
 * Routes that need a principal or a device assert that themselves; this
 * middleware's job is to establish what is true, not what is required.
 */
export default (req: NexxusApiRequest, res: NexxusApiResponse, next: NextFunction) => {
  const appId = req.headers['nxx-app-id'] as string;
  const app = NexxusApi.getStoredApp(appId);
  // Anchored and case-insensitive: the auth scheme is case-insensitive per
  // RFC 7235, so `bearer <token>` is a legitimate thing for a client to send —
  // a plain `.replace('Bearer ', '')` left it untouched and the whole header
  // was then verified as if it were the credential. Anchoring also means a
  // token can only ever lose a LEADING scheme, never something matching
  // mid-string. `\s+` rather than a single space so `Bearer` alone strips to
  // empty and is treated as no token, instead of becoming the literal token
  // "Bearer" (HTTP drops the trailing space, so that is what actually arrives).
  const token = req.headers.authorization?.replace(/^Bearer\s*/i, '').trim();

  if (!token) {
    if (app?.hasAuthEnabled()) {
      throw new NoAuthPresentException('No token provided');
    }

    return next();
  }

  // Verification needs the application's key, so an unresolvable app can't be
  // waved through here the way a missing token can be.
  if (!app) {
    throw new ApplicationNotFoundException(`Application with ID "${appId}" not found.`);
  }

  try {
    const claims = NexxusToken.verify(app, token);

    req.user = claims.user;
    req.deviceId = claims.deviceId;

    return next();
  } catch (e) {
    // Core reports the two outcomes a caller can distinguish; this maps them to
    // the HTTP-shaped exceptions the error middleware knows how to render.
    if (e instanceof TokenExpiredException) {
      throw new UserTokenExpiredException('Token has expired');
    }

    if (e instanceof InvalidTokenException) {
      throw new UserAuthenticationFailedException('Invalid token');
    }

    throw e;
  }
};
