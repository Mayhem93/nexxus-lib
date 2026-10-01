import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusToken, type NexxusApplication } from '@mayhem93/nexxus-core-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';

import SessionRoute from '../../src/api/src/lib/routes/Session';
import { NexxusApiSession } from '../../src/api/src/lib/Session';

import { installApiStatics, seedApp, makeApp, startTestServer, type TestServer } from './harness';
import { installFakeRedis } from '../redis/helpers';

let server: TestServer;
let app: NexxusApplication;

const APP_ONLY: Record<string, string> = { 'nxx-app-id': 'app1' };

const post = (path: string, body: unknown, headers: Record<string, string> = APP_ONLY) => server.request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/**
 * A zero-auth application. These routes behave the same whatever an app's
 * authentication, and a device-only session keeps the database out of the way.
 */
async function serve(): Promise<void> {
  app = seedApp(makeApp());
  server = await startTestServer(expressApp => {
    new SessionRoute(expressApp);
    // Stands in for a strategy callback, which lives under `/auth` too. The
    // provider sends the browser there, so it carries no `nxx-app-id`.
    expressApp.get('/auth/test/callback', (_req, res) => { res.status(200).json({ reached: true }); });
  });
}

/** Register device `d1` and issue it a session, returning the refresh token. */
async function signIn(): Promise<string> {
  await new NexxusDevice({ id: 'd1', appId: 'app1', name: 'Kiosk', subscriptions: [] }).save();

  return (await NexxusApiSession.issue(app, await NexxusDevice.get('d1'))).refreshToken;
}

describe('POST /auth/refresh', () => {
  beforeEach(async () => {
    installApiStatics();
    installFakeRedis();
    await serve();
  });

  afterEach(async () => { await server.close(); });

  it('returns the next access token and refresh token', async () => {
    const res = await post('/auth/refresh', { refreshToken: await signIn() });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([ 'refreshToken', 'token' ]);
    expect(NexxusToken.verify(app, res.body.token).deviceId).toBe('d1');
  });

  it('401s a refresh token it cannot exchange', async () => {
    await signIn();

    const res = await post('/auth/refresh', { refreshToken: 'd1.not-the-secret' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('InvalidRefreshTokenException');
  });

  it('400s a request carrying no refresh token', async () => {
    for (const body of [ {}, { refreshToken: '' }, { refreshToken: 42 } ]) {
      const res = await post('/auth/refresh', body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidParametersException');
    }
  });

  /**
   * By the time a client refreshes, its access token has usually expired. The
   * refresh token is the credential here, so the Authorization header must not
   * be looked at at all.
   */
  it('ignores the Authorization header', async () => {
    const res = await post(
      '/auth/refresh',
      { refreshToken: await signIn() },
      { ...APP_ONLY, authorization: 'Bearer long-expired-or-garbage' }
    );

    expect(res.status).toBe(200);
  });

  it('requires the application header, and an application that exists', async () => {
    const refreshToken = await signIn();

    expect((await post('/auth/refresh', { refreshToken }, {})).status).toBe(400);
    expect((await post('/auth/refresh', { refreshToken }, { 'nxx-app-id': 'ghost' })).status).toBe(404);
  });

  /**
   * The router is mounted at `/auth`, where strategy routes also live, so its
   * header check has to stay on its own two routes.
   */
  it('does not impose its header check on other /auth routes', async () => {
    const res = await server.request('/auth/test/callback', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });
});

describe('POST /auth/logout', () => {
  beforeEach(async () => {
    installApiStatics();
    installFakeRedis();
    await serve();
  });

  afterEach(async () => { await server.close(); });

  it('ends the session, so its refresh token stops working', async () => {
    const refreshToken = await signIn();

    expect((await post('/auth/logout', { refreshToken })).status).toBe(200);
    expect((await post('/auth/refresh', { refreshToken })).status).toBe(401);
  });

  /**
   * The same answer whether or not a session ended, as OAuth token revocation
   * (RFC 7009) gives — so logout can't be used to test which tokens are live.
   */
  it('answers a token that ends nothing exactly as it answers one that does', async () => {
    const refreshToken = await signIn();
    const miss = await post('/auth/logout', { refreshToken: 'd1.not-the-secret' });
    const hit = await post('/auth/logout', { refreshToken });

    expect(miss.status).toBe(hit.status);
    expect(miss.body).toEqual(hit.body);
  });

  it('400s a request carrying no refresh token', async () => {
    const res = await post('/auth/logout', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidParametersException');
  });
});
