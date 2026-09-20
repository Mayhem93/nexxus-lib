import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import RootRoute from '../../src/api/src/lib/routes/Root';
import DeviceRoute from '../../src/api/src/lib/routes/Device';

import { installApiStatics, seedApp, makeApp, startTestServer, type TestServer } from './harness';
import { installFakeRedis } from '../redis/helpers';

describe('GET /', () => {
  let server: TestServer;

  beforeEach(async () => {
    installApiStatics();
    installFakeRedis();
    seedApp(makeApp());
    // Mounted alongside a real route, and FIRST — exactly as `NexxusApi.init()`
    // wires it.
    server = await startTestServer(app => {
      new RootRoute(app);
      new DeviceRoute(app);
    });
  });

  afterEach(async () => { await server.close(); });

  it('answers with a greeting', async () => {
    const res = await server.request('/');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Welcome to the Nexxus API!' });
  });

  /**
   * The one that matters. This router is mounted at `/`, so it sits in front of
   * every other route — an over-broad path here (or a middleware added to it
   * later) would shadow the whole API. It must match the root and nothing else.
   */
  it('does not shadow the routes mounted after it', async () => {
    const res = await server.request('/device', { headers: { 'nxx-app-id': 'app1' } });

    // Reaches DeviceRoute and is answered by ITS rules (no device in the
    // request), not by the root handler.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidParametersException');
  });

  it('leaves an unknown path to the NotFound middleware', async () => {
    const res = await server.request('/nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NotFoundException');
  });

  /**
   * The only route that needs no application header — every other one is behind
   * `RequiredHeadersMiddleware`. That makes it the endpoint a load balancer or
   * a human can reach to see whether the process is up, so it must stay free of
   * app-scoped middleware as it grows.
   */
  it('requires no application header, token or device', async () => {
    expect((await server.request('/')).status).toBe(200);
  });

  it('answers GET only', async () => {
    for (const method of [ 'POST', 'PUT', 'DELETE', 'PATCH' ]) {
      expect((await server.request('/', { method })).status).toBe(404);
    }
  });
});
