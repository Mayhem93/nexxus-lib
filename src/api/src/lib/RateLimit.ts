import { NexxusApi, type NexxusApiConfig, type NexxusApiRequest } from './Api';
import { TooManyRequestsException } from './Exceptions';

import type { NexxusApplicationRateLimitConfig } from '@mayhem93/nexxus-core-lib';

import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

import type { Request, RequestHandler } from 'express';

/** A route the API rate-limits, named by its method and path. */
export type NexxusApiRateLimitedRoute =
  | 'POST /auth/{strategy}'
  | 'POST /auth/refresh'
  | 'POST /auth/logout'
  | 'POST /user/register'
  | 'GET /user/me'
  | 'PUT /user'
  | 'POST /device/register'
  | 'GET /device/list'
  | 'GET /device'
  | 'PUT /device'
  | 'POST /model'
  | 'POST /model/count'
  | 'POST /model/{type}/search'
  | 'GET /model/{id}'
  | 'PUT /model/{id}'
  | 'DELETE /model/{id}'
  | 'POST /subscription'
  | 'DELETE /subscription';

/** The rate-limit settings in effect for one application. */
type NexxusApiRateLimitSettings = {
  enabled: boolean;
  factor: number;
};

/**
 * Rate limiting of API requests, per route and per application.
 *
 * Each limited route allows a base number of requests a minute, multiplied by
 * the application's `rateLimit.factor`. A request counts against its user; on
 * an application without authentication, against its device; and without a
 * token, against its IP address.
 *
 * Counts are kept in this process's memory: every API instance counts on its
 * own, and a restart starts them over.
 */
export class NexxusApiRateLimit {
  /** How long a count runs, from the first request it counts, before it starts over. */
  private static readonly WINDOW_MS = 60_000;

  /** In effect for a field neither the application nor the deployment sets. */
  private static readonly DEFAULT_SETTINGS: Readonly<NexxusApiRateLimitSettings> = { enabled: false, factor: 1 };

  /** Requests a minute each route allows, before the factor. */
  private static readonly BASE_LIMITS: Readonly<Record<NexxusApiRateLimitedRoute, number>> = {
    'POST /auth/{strategy}': 5,
    // Every device refreshes on a timer, as often as every 10 minutes, and
    // without an access token the requests count per IP address, so behind a
    // NAT this count fills first.
    'POST /auth/refresh': 20,
    'POST /auth/logout': 5,
    'POST /user/register': 5,
    'GET /user/me': 60,
    'PUT /user': 60,
    'POST /device/register': 5,
    'GET /device/list': 10,
    'GET /device': 10,
    'PUT /device': 5,
    'POST /model': 60,
    'POST /model/count': 120,
    'POST /model/{type}/search': 90,
    'GET /model/{id}': 240,
    'PUT /model/{id}': 90,
    'DELETE /model/{id}': 60,
    'POST /subscription': 60,
    'DELETE /subscription': 60
  };

  /**
   * Routes that create a device. They count per user, or per IP address
   * without one, never per device: counted per device, each new device would
   * bring an allowance of its own for registering more.
   */
  private static readonly DEVICE_CREATING_ROUTES: ReadonlySet<NexxusApiRateLimitedRoute> =
    new Set<NexxusApiRateLimitedRoute>([ 'POST /device/register' ]);

  /**
   * Middleware limiting `route`. It goes after the route's own checks, right
   * before its handler: it reads the application from `nxx-app-id`, and the
   * user or device `AuthMiddleware` verified. A request refused before it is
   * not counted.
   *
   * Over the limit, the request fails with `TooManyRequestsException`.
   */
  public static limiter(route: NexxusApiRateLimitedRoute): RequestHandler {
    const base = NexxusApiRateLimit.BASE_LIMITS[route];

    return rateLimit({
      windowMs: NexxusApiRateLimit.WINDOW_MS,
      skip: req => !NexxusApiRateLimit.settingsFor(req).enabled,
      limit: req => Math.ceil(base * NexxusApiRateLimit.settingsFor(req).factor),
      keyGenerator: req => NexxusApiRateLimit.keyFor(req as NexxusApiRequest, route),
      // `RateLimit` and `RateLimit-Policy` on every counted response, and
      // `Retry-After`, in seconds, on a refused one.
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res, next) => {
        next(new TooManyRequestsException(`Too many requests; try again in ${res.getHeader('Retry-After')} seconds`));
      }
    });
  }

  /**
   * The settings in effect for the request's application: each field as the
   * application sets it, else as the deployment does, else the default.
   */
  private static settingsFor(req: Request): NexxusApiRateLimitSettings {
    const own: NexxusApplicationRateLimitConfig = NexxusApi.getStoredApp(req.headers['nxx-app-id'] as string)?.getRateLimit() ?? {};
    const deployment: NonNullable<NexxusApiConfig['rateLimit']> = NexxusApi.instance.getConfig().rateLimit ?? {};
    
    return {
      enabled: own.enabled ?? deployment.enabled ?? NexxusApiRateLimit.DEFAULT_SETTINGS.enabled,
      factor: own.factor ?? deployment.factor ?? NexxusApiRateLimit.DEFAULT_SETTINGS.factor
    };
  }

  /**
   * What a request counts against, within its application: its user, else its
   * device, else its IP address. An IPv6 address counts together with its
   * whole /56 network, the range one household gets.
   */
  private static keyFor(req: NexxusApiRequest, route: NexxusApiRateLimitedRoute): string {
    const appId = req.headers['nxx-app-id'] as string;

    if (req.user) {
      return `${appId}|user|${req.user.id}`;
    }

    if (req.deviceId && !NexxusApiRateLimit.DEVICE_CREATING_ROUTES.has(route)) {
      return `${appId}|device|${req.deviceId}`;
    }

    // The connection's address, or the one `trustProxy` picks out of
    // `X-Forwarded-For`, port removed. Undefined only once the connection is gone.
    return `${appId}|ip|${ipKeyGenerator(req.ip ?? 'unknown')}`;
  }
}
