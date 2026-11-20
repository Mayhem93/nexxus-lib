import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NexxusToken, type NexxusApplication } from '@mayhem93/nexxus-core-lib';

import { NexxusApiRateLimit } from '../../src/api/src/lib/RateLimit';
import { NexxusApiClientAddress } from '../../src/api/src/lib/ClientAddress';
import { RequiredHeadersMiddleware, AppExistsMiddleware, AuthMiddleware } from '../../src/api/src/lib/middlewares';
import SessionRoute from '../../src/api/src/lib/routes/Session';
import UserRoute from '../../src/api/src/lib/routes/User';
import DeviceRoute from '../../src/api/src/lib/routes/Device';
import ModelRoute from '../../src/api/src/lib/routes/Model';
import SubscriptionRoute from '../../src/api/src/lib/routes/Subscription';

import {
  installApiStatics, seedApp, makeApp, makeAuthApp, setApiConfig,
  startTestServer, type TestServer, type TestResponse,
} from './harness';
import { installFakeRedis } from '../redis/helpers';

import type { RequestHandler } from 'express';

let server: TestServer;

/** Who sends a request: a device token, also naming a user on an application with authentication. */
type Caller = { userId?: string; deviceId?: string };

/** Headers for a request to `app`; with a token when `caller` names a device. */
function headersFor(app: NexxusApplication, caller: Caller = {}): Record<string, string> {
  const appId = app.getData().id as string;
  const headers: Record<string, string> = { 'nxx-app-id': appId };

  if (caller.deviceId) {
    const user = caller.userId
      ? { id: caller.userId, username: caller.userId, userType: 'default', authProviders: [ 'local' ], details: {}, appId }
      : undefined;

    headers.authorization = `Bearer ${NexxusToken.issue(app, { appId, deviceId: caller.deviceId, user: user as never })}`;
  }

  return headers;
}

const post = (path: string, headers: Record<string, string>): Promise<TestResponse> =>
  server.request(path, { method: 'POST', headers });

/** Send `count` requests and return their statuses. */
async function statuses(count: number, path: string, headers: Record<string, string>): Promise<number[]> {
  const result: number[] = [];

  for (let i = 0; i < count; i++) {
    result.push((await post(path, headers)).status);
  }

  return result;
}

const twoHundreds = (count: number): number[] => Array(count).fill(200);

/**
 * Bare routes behind the same checks a real route runs first, each limited as
 * a real route with a small base:
 *   - `/logout`  as `POST /auth/logout`      (5)
 *   - `/devices` as `POST /device/register`  (5), the route that creates devices
 *   - `/device`  as `GET /device`            (10)
 *
 * Behind `trustProxy` proxies, set up as the API sets Express up.
 */
async function serveLimited(trustProxy = 0): Promise<void> {
  server = await startTestServer(expressApp => {
    const checks = [ RequiredHeadersMiddleware('nxx-app-id'), AppExistsMiddleware(), AuthMiddleware ] as RequestHandler[];
    const ok: RequestHandler = (_req, res) => { res.status(200).json({ ok: true }); };

    expressApp.set('trust proxy', trustProxy);

    if (trustProxy > 0) {
      expressApp.use(NexxusApiClientAddress.stripForwardedPorts as RequestHandler);
    }

    expressApp.post('/logout', ...checks, NexxusApiRateLimit.limiter('POST /auth/logout'), ok);
    expressApp.post('/devices', ...checks, NexxusApiRateLimit.limiter('POST /device/register'), ok);
    expressApp.post('/device', ...checks, NexxusApiRateLimit.limiter('GET /device'), ok);
  });
}

describe('NexxusApiRateLimit', () => {
  beforeEach(async () => {
    installApiStatics();
    await serveLimited();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
  });

  it('counts nothing while rate limiting is off, the default', async () => {
    const app = seedApp(makeApp());

    expect(await statuses(7, '/logout', headersFor(app))).toEqual(twoHundreds(7));

    const res = await post('/logout', headersFor(app));

    expect(res.headers.get('ratelimit')).toBeNull();
    expect(res.headers.get('ratelimit-policy')).toBeNull();
  });

  it('refuses a request over the limit with 429 and the seconds to wait', async () => {
    setApiConfig({ rateLimit: { enabled: true } });

    const app = seedApp(makeApp());

    expect(await statuses(5, '/logout', headersFor(app))).toEqual(twoHundreds(5));

    const res = await post('/logout', headersFor(app));
    const retryAfter = Number(res.headers.get('retry-after'));

    expect(res.status).toBe(429);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.body).toMatchObject({
      error: 'TooManyRequestsException',
      message: `Too many requests; try again in ${retryAfter} seconds`,
    });
  });

  it('reports the limit and what is left of it on every counted response', async () => {
    setApiConfig({ rateLimit: { enabled: true } });

    const res = await post('/logout', headersFor(seedApp(makeApp())));

    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit')).toMatch(/^"5-in-1min"; r=4; t=\d+$/);
    expect(res.headers.get('ratelimit-policy')).toMatch(/^"5-in-1min"; q=5; w=60; pk=:[A-Za-z0-9+/=]+:$/);
    // Only a refused request is told to wait, and the pre-standard headers stay off.
    expect(res.headers.get('retry-after')).toBeNull();
    expect(res.headers.get('x-ratelimit-limit')).toBeNull();
  });

  it('takes each setting from the application first, then from the deployment', async () => {
    setApiConfig({ rateLimit: { enabled: true } });

    const optedOut = seedApp(makeApp({ rateLimit: { enabled: false } }));

    expect(await statuses(7, '/logout', headersFor(optedOut))).toEqual(twoHundreds(7));

    setApiConfig({});

    const optedIn = seedApp(makeApp({ id: 'app2', rateLimit: { enabled: true } }));

    expect(await statuses(6, '/logout', headersFor(optedIn))).toEqual([ ...twoHundreds(5), 429 ]);
  });

  it('multiplies each base by the factor, rounding up', async () => {
    setApiConfig({ rateLimit: { enabled: true, factor: 2 } });

    const deploymentFactor = seedApp(makeApp());
    // Its own factor wins over the deployment's 2: 5 × 1.5 = 7.5, so 8.
    const ownFactor = seedApp(makeApp({ id: 'app2', rateLimit: { factor: 1.5 } }));

    expect((await post('/logout', headersFor(deploymentFactor))).headers.get('ratelimit-policy')).toMatch(/; q=10;/);
    expect(await statuses(9, '/logout', headersFor(ownFactor))).toEqual([ ...twoHundreds(8), 429 ]);
  });

  describe('what a request counts against', () => {
    beforeEach(() => { setApiConfig({ rateLimit: { enabled: true } }); });

    it('counts a request without a token against its IP address', async () => {
      const app = seedApp(makeApp());

      expect(await statuses(6, '/logout', headersFor(app))).toEqual([ ...twoHundreds(5), 429 ]);
      // A device's requests from the same address count on their own.
      expect((await post('/logout', headersFor(app, { deviceId: 'd1' }))).status).toBe(200);
    });

    it('ignores X-Forwarded-For without trusted proxies', async () => {
      const app = seedApp(makeApp());
      const result: number[] = [];

      for (let i = 1; i <= 6; i++) {
        result.push((await post('/logout', { ...headersFor(app), 'x-forwarded-for': `203.0.113.${i}` })).status);
      }

      expect(result).toEqual([ ...twoHundreds(5), 429 ]);
    });

    it('counts against the device on an application without authentication', async () => {
      const app = seedApp(makeApp());

      expect(await statuses(6, '/logout', headersFor(app, { deviceId: 'd1' }))).toEqual([ ...twoHundreds(5), 429 ]);
      expect((await post('/logout', headersFor(app, { deviceId: 'd2' }))).status).toBe(200);
    });

    it('counts against the user, whichever of their devices sends the request', async () => {
      const app = seedApp(makeAuthApp());

      expect(await statuses(3, '/logout', headersFor(app, { userId: 'u1', deviceId: 'd1' }))).toEqual(twoHundreds(3));
      expect(await statuses(3, '/logout', headersFor(app, { userId: 'u1', deviceId: 'd2' }))).toEqual([ 200, 200, 429 ]);
      expect((await post('/logout', headersFor(app, { userId: 'u2', deviceId: 'd3' }))).status).toBe(200);
    });

    /**
     * Counted per device, every device registered would bring an allowance of
     * its own for registering more.
     */
    it('counts device registrations against the IP address, whatever device token they carry', async () => {
      const app = seedApp(makeApp());

      expect(await statuses(3, '/devices', headersFor(app, { deviceId: 'd1' }))).toEqual(twoHundreds(3));
      expect(await statuses(2, '/devices', headersFor(app, { deviceId: 'd2' }))).toEqual(twoHundreds(2));
      expect((await post('/devices', headersFor(app, { deviceId: 'd3' }))).status).toBe(429);
      expect((await post('/devices', headersFor(app))).status).toBe(429);
    });

    it('counts a signed-in user\'s device registrations against the user', async () => {
      const app = seedApp(makeAuthApp());

      expect(await statuses(6, '/devices', headersFor(app, { userId: 'u1', deviceId: 'd1' }))).toEqual([ ...twoHundreds(5), 429 ]);
      expect((await post('/devices', headersFor(app, { userId: 'u2', deviceId: 'd2' }))).status).toBe(200);
    });
  });

  it('keeps each application\'s counts apart', async () => {
    setApiConfig({ rateLimit: { enabled: true } });

    const first = seedApp(makeApp());
    const second = seedApp(makeApp({ id: 'app2' }));

    expect(await statuses(6, '/logout', headersFor(first))).toEqual([ ...twoHundreds(5), 429 ]);
    expect((await post('/logout', headersFor(second))).status).toBe(200);
  });

  it('keeps each route\'s counts apart', async () => {
    setApiConfig({ rateLimit: { enabled: true } });

    const app = seedApp(makeApp());

    expect(await statuses(6, '/logout', headersFor(app))).toEqual([ ...twoHundreds(5), 429 ]);

    const res = await post('/device', headersFor(app));

    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit')).toMatch(/^"10-in-1min"; r=9;/);
  });

  it('does not count a request refused before it', async () => {
    setApiConfig({ rateLimit: { enabled: true } });

    // Without authentication, so that a request without a token gets through,
    // counted against the IP address the refused ones came from.
    const app = seedApp(makeApp());

    for (let i = 0; i < 6; i++) {
      const refused = await post('/logout', { ...headersFor(app), authorization: 'Bearer not-a-token' });

      expect(refused.status).toBe(401);
      expect(refused.headers.get('ratelimit')).toBeNull();
    }

    const res = await post('/logout', headersFor(app));

    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit')).toMatch(/; r=4;/);
  });

  it('starts a count over a minute after its first request', async () => {
    setApiConfig({ rateLimit: { enabled: true } });

    const app = seedApp(makeApp());

    // Only `Date` is faked: the store reads it to tell when a count has run its minute.
    vi.useFakeTimers({ toFake: [ 'Date' ] });

    expect(await statuses(6, '/logout', headersFor(app))).toEqual([ ...twoHundreds(5), 429 ]);

    vi.setSystemTime(Date.now() + 60_000);

    const res = await post('/logout', headersFor(app));

    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit')).toMatch(/; r=4;/);
  });
});

describe('NexxusApiRateLimit — behind one proxy', () => {
  beforeEach(async () => {
    installApiStatics();
    setApiConfig({ rateLimit: { enabled: true } });
    await serveLimited(1);
  });

  afterEach(async () => { await server.close(); });

  /** One request whose `X-Forwarded-For` is `forwardedFor`, as the proxy passes it on. */
  const forwarded = (app: NexxusApplication, forwardedFor: string): Promise<TestResponse> =>
    post('/logout', { ...headersFor(app), 'x-forwarded-for': forwardedFor });

  it('counts against the address the proxy added, whatever the client wrote before it', async () => {
    const app = seedApp(makeApp());
    const result: number[] = [];

    for (let i = 1; i <= 6; i++) {
      result.push((await forwarded(app, `198.51.100.${i}, 203.0.113.7`)).status);
    }

    expect(result).toEqual([ ...twoHundreds(5), 429 ]);
    expect((await forwarded(app, '203.0.113.8')).status).toBe(200);
  });

  it('counts every port of an address as one client', async () => {
    const app = seedApp(makeApp());
    const result: number[] = [];

    for (let i = 1; i <= 6; i++) {
      result.push((await forwarded(app, `203.0.113.7:${40_000 + i}`)).status);
    }

    expect(result).toEqual([ ...twoHundreds(5), 429 ]);
  });
});

/**
 * One request per route, past the route's own checks, reading the limit off
 * `RateLimit-Policy`. The route's handler may turn the request down; the
 * limiter has counted it by then.
 */
describe('Rate-limited routes', () => {
  const ROUTES: Array<{ route: string; method: string; path: string; base: number; signedIn: boolean }> = [
    { route: 'POST /auth/refresh',        method: 'POST',   path: '/auth/refresh',      base: 20,  signedIn: false },
    { route: 'POST /auth/logout',         method: 'POST',   path: '/auth/logout',       base: 5,   signedIn: false },
    { route: 'POST /user/register',       method: 'POST',   path: '/user/register',     base: 5,   signedIn: false },
    { route: 'GET /user/me',              method: 'GET',    path: '/user/me',           base: 60,  signedIn: true },
    { route: 'PUT /user',                 method: 'PUT',    path: '/user',              base: 60,  signedIn: true },
    { route: 'POST /device/register',     method: 'POST',   path: '/device/register',   base: 5,   signedIn: true },
    { route: 'GET /device/list',          method: 'GET',    path: '/device/list',       base: 10,  signedIn: true },
    { route: 'GET /device',               method: 'GET',    path: '/device',            base: 10,  signedIn: true },
    { route: 'PUT /device',               method: 'PUT',    path: '/device',            base: 5,   signedIn: true },
    { route: 'POST /model',               method: 'POST',   path: '/model',             base: 60,  signedIn: true },
    { route: 'POST /model/count',         method: 'POST',   path: '/model/count',       base: 120, signedIn: true },
    { route: 'POST /model/{type}/search', method: 'POST',   path: '/model/runs/search', base: 90,  signedIn: true },
    { route: 'GET /model/{id}',           method: 'GET',    path: '/model/m1',          base: 240, signedIn: true },
    { route: 'PUT /model/{id}',           method: 'PUT',    path: '/model/m1',          base: 90,  signedIn: true },
    { route: 'DELETE /model/{id}',        method: 'DELETE', path: '/model/m1',          base: 60,  signedIn: true },
    { route: 'POST /subscription',        method: 'POST',   path: '/subscription',      base: 60,  signedIn: true },
    { route: 'DELETE /subscription',      method: 'DELETE', path: '/subscription',      base: 60,  signedIn: true },
  ];

  let app: NexxusApplication;

  beforeEach(async () => {
    installApiStatics();
    installFakeRedis();
    setApiConfig({ rateLimit: { enabled: true } });
    app = seedApp(makeAuthApp());
    server = await startTestServer(expressApp => {
      new SessionRoute(expressApp);
      new UserRoute(expressApp);
      new DeviceRoute(expressApp);
      new ModelRoute(expressApp);
      new SubscriptionRoute(expressApp);
    });
  });

  afterEach(async () => { await server.close(); });

  it.each(ROUTES)('$route allows $base requests a minute', async ({ method, path, base, signedIn }) => {
    const res = await server.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'nxx-connection-id': 'c1',
        ...headersFor(app, signedIn ? { userId: 'u1', deviceId: 'd1' } : {}),
      },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });

    expect(res.headers.get('ratelimit-policy')).toMatch(new RegExp(`^"${base}-in-1min"; q=${base}; w=60;`));
  });
});
