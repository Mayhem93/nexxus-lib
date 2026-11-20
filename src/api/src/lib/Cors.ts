import { OriginNotAllowedException } from './Exceptions';

import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * CORS: which browser pages, served from origins other than the API's own, may
 * call it. Only browsers act on any of this; servers, scripts and mobile apps
 * are never affected.
 *
 * A browser asks first, with an `OPTIONS` preflight to the same URL, whenever a
 * request carries custom headers — which every Nexxus request does
 * (`nxx-app-id`, `Authorization`, a JSON body). The preflight carries none of
 * them, so the answer can only depend on the origin.
 */
export class NexxusApiCors {
  /** In `cors.origins`: any origin at all. */
  private static readonly ANY_ORIGIN = '*';

  private static readonly ALLOWED_METHODS = 'GET, POST, PUT, DELETE';

  private static readonly ALLOWED_HEADERS = 'Authorization, Content-Type, nxx-app-id, nxx-connection-id';

  /** Response headers a page may read beyond the handful browsers always show. */
  private static readonly EXPOSED_HEADERS = 'Retry-After, RateLimit, RateLimit-Policy';

  /** How long a browser may reuse a preflight's answer: Chrome's cap, 2 hours. */
  private static readonly PREFLIGHT_MAX_AGE_SECONDS = 7200;

  /**
   * Middleware answering browsers on the listed `origins`. It goes first: every
   * response, errors included, has to carry the headers, or a page sees a
   * refused request instead of its status.
   *
   * - A preflight from a listed origin is answered `204`; from any other,
   *   `OriginNotAllowedException`.
   * - Any other request from a listed origin gets `Access-Control-Allow-Origin`
   *   and the exposed headers; from any other origin it is served without them,
   *   which a browser on another origin can't read.
   */
  public static middleware(origins: readonly string[]): RequestHandler {
    const anyOrigin = origins.includes(NexxusApiCors.ANY_ORIGIN);
    const listed: ReadonlySet<string> = new Set(
      origins.filter(origin => origin !== NexxusApiCors.ANY_ORIGIN).map(NexxusApiCors.normalize)
    );

    return (req: Request, res: Response, next: NextFunction): void => {
      const origin = req.headers.origin;

      if (origin === undefined) {
        next();

        return;
      }

      const allowed = anyOrigin || listed.has(origin);

      // The answer differs per origin unless every origin gets the same one.
      if (!anyOrigin) {
        res.vary('Origin');
      }

      if (NexxusApiCors.isPreflight(req)) {
        if (!allowed) {
          next(new OriginNotAllowedException(`Origin "${origin}" is not in the API's cors.origins`));

          return;
        }

        res.setHeader('Access-Control-Allow-Origin', anyOrigin ? NexxusApiCors.ANY_ORIGIN : origin);
        res.setHeader('Access-Control-Allow-Methods', NexxusApiCors.ALLOWED_METHODS);
        res.setHeader('Access-Control-Allow-Headers', NexxusApiCors.ALLOWED_HEADERS);
        res.setHeader('Access-Control-Max-Age', String(NexxusApiCors.PREFLIGHT_MAX_AGE_SECONDS));
        res.status(204).end();

        return;
      }

      if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', anyOrigin ? NexxusApiCors.ANY_ORIGIN : origin);
        res.setHeader('Access-Control-Expose-Headers', NexxusApiCors.EXPOSED_HEADERS);
      }

      next();
    };
  }

  /** A browser asking before the real request: an `OPTIONS` naming the method to come. */
  private static isPreflight(req: Request): boolean {
    return req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
  }

  /**
   * An origin as browsers send it: lower case, and without a default port
   * (`https://App.example.com:443` is sent as `https://app.example.com`).
   */
  private static normalize(origin: string): string {
    return new URL(origin).origin;
  }
}
