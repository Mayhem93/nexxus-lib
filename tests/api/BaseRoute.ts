import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { NexxusApiBaseRoute } from '../../src/api/src/lib/BaseRoute';
import { NotFoundException } from '../../src/api/src/lib/Exceptions';

import { installApiStatics, startTestServer, type TestServer } from './harness';

import { Router } from 'express';
import type { RequestHandler } from 'express';

/** Records the order in which the base class drives construction. */
const constructionLog: string[] = [];

class ThingsRoute extends NexxusApiBaseRoute {
  constructor(parent: Router) {
    super('/things', parent);
  }

  protected registerRoutes(): void {
    constructionLog.push('registerRoutes');

    this.router.get('/', ((_req, res) => { res.status(200).json({ route: 'things', at: '/' }); }) as RequestHandler);
    this.router.post('/', ((req, res) => { res.status(201).json({ echo: req.body }); }) as RequestHandler);
    // Before `/:id` — Express matches in registration order, so a literal path
    // declared after a parameter one is unreachable.
    this.router.get('/boom', (() => { throw new NotFoundException('nothing here'); }) as RequestHandler);
    this.router.get('/:id', ((req, res) => { res.status(200).json({ route: 'things', id: req.params.id }); }) as RequestHandler);
  }
}

/** A second route, to prove two subclasses mounted on one parent stay separate. */
class OtherRoute extends NexxusApiBaseRoute {
  constructor(parent: Router) {
    super('/other', parent);
  }

  protected registerRoutes(): void {
    this.router.get('/', ((_req, res) => { res.status(200).json({ route: 'other' }); }) as RequestHandler);
  }
}

describe('NexxusApiBaseRoute', () => {
  let server: TestServer;

  // Describe-scoped, not module-level: a module-level hook registers on the
  // test FILE's root suite and would run before every test in every imported
  // suite. See the note in harness.ts.
  beforeEach(async () => {
    installApiStatics();
    constructionLog.length = 0;
    server = await startTestServer(app => {
      new ThingsRoute(app);
      new OtherRoute(app);
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('registers the subclass routes during construction', () => {
    // `registerRoutes` is abstract and called by the base constructor, so a
    // subclass never has to remember to call it — this is what makes
    // `new ThingsRoute(app)` a complete statement.
    expect(constructionLog).toEqual([ 'registerRoutes' ]);
  });

  it('serves the subclass routes under its base path', async () => {
    const res = await server.request('/things');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ route: 'things', at: '/' });
  });

  it('keeps path parameters working under the mount point', async () => {
    const res = await server.request('/things/42');

    expect(res.body).toEqual({ route: 'things', id: '42' });
  });

  it('does not serve the subclass routes at the parent root', async () => {
    // The router is mounted AT `basePath`, so its `/` is `/things` and nothing
    // the subclass declares leaks to the top level.
    expect((await server.request('/')).status).toBe(404);
  });

  it('isolates two routes mounted on the same parent', async () => {
    expect((await server.request('/other')).body).toEqual({ route: 'other' });
    expect((await server.request('/other/42')).status).toBe(404);
  });

  it('exposes the router it built', () => {
    const route = new ThingsRoute(Router());

    // getRouter() must hand back the SAME router the routes were registered on,
    // not a fresh one — a copy would be silently empty.
    expect(route.getRouter()).toBe((route as unknown as { router: Router }).router);
  });

  it('lets a handler exception reach the error middleware', async () => {
    // Express 5 forwards a synchronous throw from a handler, which is the whole
    // reason the middlewares in this package are allowed to throw rather than
    // call next(err).
    const res = await server.request('/things/boom');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'NotFoundException', message: 'nothing here' });
  });

  it('falls through to the NotFound middleware for an unknown path', async () => {
    const res = await server.request('/nope');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'NotFoundException' });
  });

  it('parses a JSON body before the route sees it', async () => {
    const res = await server.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ echo: { hello: 'world' } });
  });
});
