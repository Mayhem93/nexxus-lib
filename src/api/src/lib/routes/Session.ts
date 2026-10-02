import { NexxusApiBaseRoute } from '../BaseRoute';
import {
  type NexxusApiRequest,
  type NexxusApiResponse,
  NexxusApi
} from '../Api';
import { RequiredHeadersMiddleware, AppExistsMiddleware } from '../middlewares';
import { InvalidParametersException } from '../Exceptions';
import { NexxusApiSession } from '../Session';

import type { Router, RequestHandler } from 'express';

interface SessionRequest extends NexxusApiRequest {
  body: { refreshToken?: unknown };
}

/**
 * `POST /auth/refresh` and `POST /auth/logout` — the session lifecycle, the same
 * for every application whatever its authentication method, zero-auth included.
 *
 * No `AuthMiddleware`: by the time a client refreshes, its access token has
 * usually expired, and it's the refresh token in the body that is the credential
 * on both routes.
 */
export default class SessionRoute extends NexxusApiBaseRoute {
  /**
   * The names these routes occupy under `/auth`. Strategy routes live there too,
   * as `/auth/<strategyName>`, so a strategy registered under one of these names
   * would claim a built-in route — the API refuses such a strategy at startup.
   */
  public static readonly RESERVED_NAMES: ReadonlySet<string> = new Set([ 'refresh', 'logout' ]);

  constructor(appRouter: Router) {
    super('/auth', appRouter);
  }

  protected registerRoutes(): void {
    // Per route, NOT `this.router.use()`: this router is mounted at `/auth`, so
    // router-level middleware would run for every `/auth/*` request — including
    // `/auth/<strategy>/callback`, which never carries `nxx-app-id` because the
    // OAuth provider, not the client, sends the browser there.
    const guards = [
      RequiredHeadersMiddleware('nxx-app-id') as RequestHandler,
      AppExistsMiddleware() as RequestHandler
    ];

    this.router.post('/refresh', ...guards, this.refresh.bind(this) as RequestHandler);
    this.router.post('/logout', ...guards, this.logout.bind(this) as RequestHandler);
  }

  private async refresh(req: SessionRequest, res: NexxusApiResponse): Promise<void> {
    // Non-null: AppExistsMiddleware is wired on this route.
    const app = NexxusApi.getStoredApp(req.headers['nxx-app-id'] as string)!;

    res.status(200).json(await NexxusApiSession.refresh(app, SessionRoute.refreshTokenFrom(req)));
  }

  private async logout(req: SessionRequest, res: NexxusApiResponse): Promise<void> {
    // Non-null: AppExistsMiddleware is wired on this route.
    const app = NexxusApi.getStoredApp(req.headers['nxx-app-id'] as string)!;

    await NexxusApiSession.revoke(app, SessionRoute.refreshTokenFrom(req));

    // The same answer whether or not a session ended — see `revoke`.
    res.status(200).json({ message: 'Logged out' });
  }

  /** The body's refresh token. A missing one is a malformed request, not a bad credential. */
  private static refreshTokenFrom(req: SessionRequest): string {
    const refreshToken = req.body?.refreshToken;

    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw new InvalidParametersException('Missing refresh token in request body');
    }

    return refreshToken;
  }
}
