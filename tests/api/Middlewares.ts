import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FatalErrorException, InvalidTokenException } from '@mayhem93/nexxus-core-lib';

// NotFound and Error aren't imported here: `startTestServer` mounts that pair
// on every app it builds, exactly as `NexxusApi.init()` does — so they're
// already under test on every request in this file.
import {
  RequestLoggerMiddleware,
  RequiredHeadersMiddleware,
  AppExistsMiddleware,
  RequiresUserMiddleware,
  RequiresDeviceMiddleware,
  AvailabilityMiddleware,
} from '../../src/api/src/lib/middlewares';
import { AccessDeniedException, InvalidParametersException } from '../../src/api/src/lib/Exceptions';
import type { NexxusApiRequest } from '../../src/api/src/lib/Api';

import {
  installApiStatics,
  seedApp,
  makeApp,
  logger,
  startTestServer,
  type TestServer,
} from './harness';

import type { RequestHandler } from 'express';

/** Terminal handler: proves the chain reached the route, and reports what it set. */
const reached: RequestHandler = (req, res) => {
  const r = req as NexxusApiRequest;

  res.status(200).json({ reached: true, user: r.user ?? null, deviceId: r.deviceId ?? null });
};

/** Poll until `predicate` holds — for the things that happen after a response is sent. */
async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }

    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('RequiredHeadersMiddleware', () => {
  let server: TestServer;

  beforeEach(async () => {
    installApiStatics();
    server = await startTestServer(app => {
      app.use(RequiredHeadersMiddleware('nxx-app-id') as RequestHandler);
      app.get('/', reached);
    });
  });

  afterEach(async () => { await server.close(); });

  it('passes the request through when the header is present', async () => {
    const res = await server.request('/', { headers: { 'nxx-app-id': 'app1' } });

    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it('rejects a missing header, naming it', async () => {
    const res = await server.request('/');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'InvalidParametersException',
      message: 'Missing required header: nxx-app-id',
    });
  });

  it('treats an empty header as missing', async () => {
    // The check is on the VALUE, not on presence — `nxx-app-id: ` would
    // otherwise sail through and become a lookup for the empty string.
    const res = await server.request('/', { headers: { 'nxx-app-id': '' } });

    expect(res.status).toBe(400);
  });
});

describe('AppExistsMiddleware', () => {
  let server: TestServer;

  beforeEach(async () => {
    installApiStatics();
    seedApp(makeApp());
    server = await startTestServer(app => {
      app.use(AppExistsMiddleware() as RequestHandler);
      app.get('/', reached);
    });
  });

  afterEach(async () => { await server.close(); });

  it('passes the request through for a loaded application', async () => {
    const res = await server.request('/', { headers: { 'nxx-app-id': 'app1' } });

    expect(res.status).toBe(200);
  });

  it('rejects an unknown application with a 404 naming the id', async () => {
    const res = await server.request('/', { headers: { 'nxx-app-id': 'ghost' } });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: 'ApplicationNotFoundException',
      message: 'Application with ID "ghost" not found.',
    });
  });

  it('reports a MISSING header as an unknown application, not a bad request', async () => {
    // This middleware never checks that the header is there — it looks up
    // whatever it finds, and `undefined` is simply not a loaded app. Routes get
    // the clearer "missing header" 400 by wiring RequiredHeaders ahead of it;
    // anything wiring this alone gets a 404 instead.
    const res = await server.request('/');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ApplicationNotFoundException');
  });
});

describe('AvailabilityMiddleware', () => {
  let server: TestServer;
  let available: boolean;

  beforeEach(async () => {
    installApiStatics();
    available = true;
    server = await startTestServer(app => {
      app.use(AvailabilityMiddleware(() => available) as RequestHandler);
      app.get('/', reached);
    });
  });

  afterEach(async () => { await server.close(); });

  it('lets requests through while the upstreams are up', async () => {
    expect((await server.request('/')).status).toBe(200);
  });

  it('503s while an upstream is down', async () => {
    available = false;

    const res = await server.request('/');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ServiceUnavailableException');
  });

  it('reads availability per request, not at wiring time', async () => {
    // The whole reason it takes a getter rather than a boolean: the middleware
    // is installed once at boot, and an upstream that drops and recovers has to
    // change the answer without re-wiring anything.
    expect((await server.request('/')).status).toBe(200);

    available = false;
    expect((await server.request('/')).status).toBe(503);

    available = true;
    expect((await server.request('/')).status).toBe(200);
  });

  it('names no upstream in the response body', async () => {
    available = false;

    const res = await server.request('/');

    expect(JSON.stringify(res.body)).not.toMatch(/database|redis|queue|elastic|rabbit/i);
  });
});

describe('RequiresUserMiddleware', () => {
  let server: TestServer;
  let principal: unknown;

  beforeEach(async () => {
    installApiStatics();
    principal = undefined;
    server = await startTestServer(app => {
      // Stands in for AuthMiddleware, which is what populates `req.user`.
      app.use(((req, _res, next) => { (req as NexxusApiRequest).user = principal as never; next(); }) as RequestHandler);
      app.use(RequiresUserMiddleware as RequestHandler);
      app.get('/', reached);
    });
  });

  afterEach(async () => { await server.close(); });

  it('passes through when a principal is present', async () => {
    principal = { id: 'u1', username: 'ann' };

    const res = await server.request('/');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'u1' });
  });

  it('rejects a request with no principal', async () => {
    const res = await server.request('/');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidAuthMethodException');
    expect(res.body.message).toMatch(/requires an authenticated user/);
  });

  it('rejects a principal carrying no id', async () => {
    // It checks `user?.id`, not merely `user`, because `id` is the field the
    // handlers actually dereference — a user object without one would reach a
    // route and produce an undefined lookup rather than a 400.
    principal = { username: 'ann' };

    expect((await server.request('/')).status).toBe(400);
  });
});

describe('RequiresDeviceMiddleware', () => {
  let server: TestServer;
  let deviceId: string | undefined;

  beforeEach(async () => {
    installApiStatics();
    deviceId = undefined;
    server = await startTestServer(app => {
      app.use(((req, _res, next) => { (req as NexxusApiRequest).deviceId = deviceId; next(); }) as RequestHandler);
      app.use(RequiresDeviceMiddleware as RequestHandler);
      app.get('/', reached);
    });
  });

  afterEach(async () => { await server.close(); });

  it('passes through when the token named a device', async () => {
    deviceId = 'd1';

    const res = await server.request('/');

    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe('d1');
  });

  it('rejects a request carrying no device, pointing at the fix', async () => {
    const res = await server.request('/');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidParametersException');
    expect(res.body.message).toMatch(/POST \/device\/register/);
  });
});

describe('NotFoundMiddleware', () => {
  let server: TestServer;

  beforeEach(async () => {
    installApiStatics();
    server = await startTestServer(app => {
      app.get('/known', reached);
    });
  });

  afterEach(async () => { await server.close(); });

  it('turns an unmatched path into a 404 exception', async () => {
    const res = await server.request('/unknown');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'NotFoundException', message: 'Not Found' });
  });

  it('answers for an unmatched METHOD on a known path too', async () => {
    expect((await server.request('/known', { method: 'DELETE' })).status).toBe(404);
  });

  it('leaves matched routes alone', async () => {
    expect((await server.request('/known')).status).toBe(200);
  });
});

describe('RequestLoggerMiddleware', () => {
  let server: TestServer;

  beforeEach(async () => {
    installApiStatics();
    server = await startTestServer(app => {
      app.use(RequestLoggerMiddleware as RequestHandler);
      app.get('/known', reached);
      app.get('/boom', (() => { throw new AccessDeniedException(); }) as RequestHandler);
    });
  });

  afterEach(async () => { await server.close(); });

  it('logs method, path and status once the response is finished', async () => {
    await server.request('/known');

    // Logged from the response's `finish` event, so it lands after the client
    // already has its answer — poll rather than assume ordering.
    await waitFor(() => logger.has('info', /GET \/known - 200/));
  });

  it('logs the FINAL status, not the one at entry', async () => {
    // It subscribes on the way in but reads `res.statusCode` on the way out,
    // which is the only reason a 403 decided downstream shows up as a 403.
    await server.request('/boom');

    await waitFor(() => logger.has('info', /GET \/boom - 403/));
  });

  it('does not swallow the request', async () => {
    expect((await server.request('/known')).status).toBe(200);
  });
});

describe('ErrorMiddleware', () => {
  let server: TestServer;
  let toThrow: unknown;
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    installApiStatics();
    originalNodeEnv = process.env.NODE_ENV;
    toThrow = new InvalidParametersException('bad input');
    server = await startTestServer(app => {
      app.get('/throw', (() => { throw toThrow; }) as RequestHandler);
      app.get('/next', ((_req, _res, next) => { next(toThrow); }) as RequestHandler);
    });
  });

  afterEach(async () => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    await server.close();
  });

  it('renders an API exception at its own status code', async () => {
    const res = await server.request('/throw');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'InvalidParametersException', message: 'bad input' });
  });

  it('handles next(err) and a thrown error identically', async () => {
    const thrown = await server.request('/throw');
    const passed = await server.request('/next');

    expect(passed.status).toBe(thrown.status);
    expect(passed.body).toEqual(thrown.body);
  });

  it('replaces an unrecognized error with a generic 500, leaking nothing', async () => {
    toThrow = new Error('connection string postgres://user:hunter2@db:5432 refused');

    const res = await server.request('/throw');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'ServerErrorException', message: 'An unexpected server error occurred.' });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2/);
  });

  it('replaces a fatal error with its own generic 500', async () => {
    toThrow = new FatalErrorException('redis cluster unreachable at 10.0.0.4');

    const res = await server.request('/throw');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('A fatal server error occurred.');
    expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.4/);
  });

  /**
   * A core exception is a `NexxusException` but not a `NexxusApiException`, so
   * it has no `statusCode` and falls back to 500 — while KEEPING its own name
   * and message. That's the gap the API's own exception classes exist to close:
   * anything core throws that reaches a client unwrapped says more than it
   * should. `AuthMiddleware` translating core's token errors is exactly this
   * being done properly.
   */
  it('falls back to 500 for a core exception, passing its message through', async () => {
    toThrow = new InvalidTokenException('jwt malformed');

    const res = await server.request('/throw');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'InvalidTokenException', message: 'jwt malformed' });
  });

  it('logs 5xx at error level with the stack, and 4xx at info without it', async () => {
    await server.request('/throw'); // 400
    expect(logger.has('info', /bad input/)).toBe(true);
    expect(logger.has('error', /bad input/)).toBe(false);

    logger.entries = [];
    toThrow = new Error('boom');
    await server.request('/throw'); // 500

    expect(logger.has('error', /An unexpected server error occurred/)).toBe(true);
    expect(logger.has('info', /An unexpected server error occurred/)).toBe(false);
  });

  it('omits the stack from the response body outside dev', async () => {
    process.env.NODE_ENV = 'production';

    expect((await server.request('/throw')).body.stack).toBeUndefined();
  });

  it('includes the stack in the response body in dev', async () => {
    process.env.NODE_ENV = 'dev';

    const res = await server.request('/throw');

    expect(res.body.stack).toContain('InvalidParametersException');
  });

  it('reads NODE_ENV per request, so the mode can change without a restart', async () => {
    process.env.NODE_ENV = 'dev';
    expect((await server.request('/throw')).body.stack).toBeDefined();

    process.env.NODE_ENV = 'production';
    expect((await server.request('/throw')).body.stack).toBeUndefined();
  });
});

describe('middleware composition', () => {
  let server: TestServer;

  beforeEach(async () => {
    installApiStatics();
    seedApp(makeApp());
    server = await startTestServer(app => {
      app.use(RequiredHeadersMiddleware('nxx-app-id') as RequestHandler);
      app.use(AppExistsMiddleware() as RequestHandler);
      app.get('/', reached);
    });
  });

  afterEach(async () => { await server.close(); });

  it('stops at the FIRST failing middleware', async () => {
    // Ordering is the point: RequiredHeaders runs first so a missing header is
    // a 400 "missing header" rather than AppExists' less useful 404 for an
    // application called `undefined`.
    const res = await server.request('/');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidParametersException');
  });

  it('runs the whole chain when every check passes', async () => {
    const res = await server.request('/', { headers: { 'nxx-app-id': 'app1' } });

    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });
});
