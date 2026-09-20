import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  NexxusToken, NexxusAppModel, NexxusAclManager, NexxusAclRole, DEFAULT_ACL_ROLE_ID,
  type INexxusAclRole, type NexxusAclStatement, type NexxusApplication,
} from '@mayhem93/nexxus-core-lib';
import { NexxusModelFieldCache } from '@mayhem93/nexxus-redis';

import ModelRoute from '../../src/api/src/lib/routes/Model';

import {
  installApiStatics, seedApp, makeApp, makeAuthApp, dbState, mqState,
  startTestServer, type TestServer,
} from './harness';
import { installFakeRedis } from '../redis/helpers';

const USER = {
  id: 'u1', username: 'ann', userType: 'default',
  authProviders: [ 'local' ], details: {}, appId: 'app1',
} as never;

const SCHEMA = {
  runs: {
    fields: {
      note:     { type: 'string', required: false, filterable: true },
      distance: { type: 'int', required: false, filterable: true },
      owner:    { type: 'string', required: false, filterable: true, acl: true },
    },
  },
  pings:   { transient: true, fields: { note: { type: 'string', required: false } } },
  reports: { subscribable: false, fields: { note: { type: 'string', required: false } } },
};

let server: TestServer;
let app: NexxusApplication;

const APP_ONLY: Record<string, string> = { 'nxx-app-id': 'app1' };

function as(user: unknown = USER): Record<string, string> {
  return {
    'nxx-app-id': 'app1',
    authorization: `Bearer ${NexxusToken.issue(app, { appId: 'app1', deviceId: 'd1', user: user as never })}`,
  };
}

const send = (method: string, path: string, body: unknown, headers: Record<string, string> = APP_ONLY) =>
  server.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const stored = (props: Record<string, unknown>): NexxusAppModel =>
  new NexxusAppModel({ appId: 'app1', ...props } as never, null);

async function serve(application: NexxusApplication): Promise<void> {
  app = seedApp(application);
  server = await startTestServer(expressApp => { new ModelRoute(expressApp); });
}

/** An ACL-enabled app whose `default` user type resolves to `statements`. */
function aclApp(statements: NexxusAclStatement[]): NexxusApplication {
  const application = makeAuthApp({
    schema: SCHEMA,
    auth: { strategies: { local: {} }, userDetailSchema: { default: {} }, acl: true },
  });

  application.setRoleManagers([ new NexxusAclManager(new NexxusAclRole({
    id: DEFAULT_ACL_ROLE_ID, type: 'acl', appId: 'app1', statements: JSON.stringify(statements),
  } as INexxusAclRole)) ]);

  return application;
}

const ALLOW_OWN: NexxusAclStatement[] = [ {
  effect: 'Allow', action: [ '*' ], resource: [ 'runs' ],
  condition: { StringEquals: { userId: [ '$nxx:userId' ] } },
} ];

describe('POST /model — create', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('publishes to the writer and answers 202', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await send('POST', '/model', { type: 'runs', note: 'first run', distance: 5 });

    expect(res.status).toBe(202);
    expect(mqState.published[0]).toMatchObject({
      queue: 'writer',
      message: { event: 'model_created', data: { type: 'runs', note: 'first run', distance: 5, appId: 'app1' } },
    });
  });

  it('stamps the creating user as the owner', async () => {
    await serve(makeAuthApp({ schema: SCHEMA }));

    await send('POST', '/model', { type: 'runs', note: 'x' }, as());

    expect(mqState.published[0]!.message.data.userId).toBe('u1');
  });

  /**
   * Transient models are notification-shaped — they exist only long enough to
   * fan out. Publishing straight to the transport manager skips the database
   * write and the writer's re-validate hop.
   */
  it('routes a transient model to the transport manager instead of the writer', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    await send('POST', '/model', { type: 'pings', note: 'ping' });

    expect(mqState.published[0]!.queue).toBe('transport-manager');
  });

  it('404s a model the schema does not declare', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await send('POST', '/model', { type: 'ghost' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ModelNotFoundException');
  });

  it('rejects a field the model schema does not declare', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await send('POST', '/model', { type: 'runs', undeclared: 'x' });

    expect(res.status).toBe(500);
    expect(mqState.published).toHaveLength(0);
  });

  it('403s when no role allows creating', async () => {
    await serve(aclApp([ { effect: 'Allow', action: [ 'read' ], resource: [ 'runs' ] } ]));

    const res = await send('POST', '/model', { type: 'runs', note: 'x' }, as());

    expect(res.status).toBe(403);
    expect(mqState.published).toHaveLength(0);
  });

  /**
   * `userId` is applied AFTER the body is spread, so a client-supplied one is
   * overwritten rather than honoured. Ownership can't be forged at creation —
   * which is also why the row check below always passes for a role that may
   * only create what it owns.
   */
  it('stamps ownership from the token, ignoring a client-supplied userId', async () => {
    await serve(makeAuthApp({ schema: SCHEMA }));

    await send('POST', '/model', { type: 'runs', note: 'x', userId: 'someone-else' }, as());

    expect(mqState.published[0]!.message.data.userId).toBe('u1');
  });

  it('row-checks the object it is about to create', async () => {
    await serve(aclApp(ALLOW_OWN));

    const res = await send('POST', '/model', { type: 'runs', note: 'x' }, as());

    expect(res.status).toBe(202);
    expect(mqState.published[0]!.message.data.userId).toBe('u1');
  });
});

describe('GET /model/:id', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('returns the object', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    dbState.getItemsResult = [ stored({ id: 'm1', type: 'runs', note: 'hi' }) ];

    const res = await server.request('/model/m1?type=runs', { headers: APP_ONLY });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'm1', note: 'hi' });
  });

  it('requires the type query parameter', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await server.request('/model/m1', { headers: APP_ONLY });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/"type" is required/);
  });

  it('404s an unknown model type and a missing object', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    expect((await server.request('/model/m1?type=ghost', { headers: APP_ONLY })).status).toBe(404);

    dbState.getItemsResult = [];
    expect((await server.request('/model/m1?type=runs', { headers: APP_ONLY })).status).toBe(404);
  });

  it('403s an object that fails the row condition', async () => {
    await serve(aclApp(ALLOW_OWN));
    dbState.getItemsResult = [ stored({ id: 'm1', type: 'runs', userId: 'someone-else' }) ];

    const res = await server.request('/model/m1?type=runs', { headers: as() });

    expect(res.status).toBe(403);
    // The body must not reveal that the object exists.
    expect(res.body.message).toBe('Access denied');
  });

  it('returns an object that satisfies the row condition', async () => {
    await serve(aclApp(ALLOW_OWN));
    dbState.getItemsResult = [ stored({ id: 'm1', type: 'runs', userId: 'u1' }) ];

    expect((await server.request('/model/m1?type=runs', { headers: as() })).status).toBe(200);
  });
});

describe('PUT /model/:id — update', () => {
  const patch = (body: unknown, headers = APP_ONLY) => send('PUT', '/model/m1', body, headers);

  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('publishes the validated patch to the writer', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await patch({ type: 'runs', patch: { op: 'replace', path: [ 'note' ], value: [ 'edited' ] } });

    expect(res.status).toBe(202);
    expect(mqState.published[0]).toMatchObject({ queue: 'writer', message: { event: 'model_updated' } });
    expect(mqState.published[0]!.message.data[0]).toMatchObject({
      path: [ 'note' ], metadata: { id: 'm1', type: 'runs', appId: 'app1' },
    });
  });

  it('rejects a patch the model schema does not allow', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await patch({ type: 'runs', patch: { op: 'replace', path: [ 'ghost' ], value: [ 'x' ] } });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid JSON Patch/);
    expect(mqState.published).toHaveLength(0);
  });

  it('404s a model the schema does not declare', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await patch({ type: 'ghost', patch: { op: 'replace', path: [ 'note' ], value: [ 'x' ] } });

    expect(res.status).toBe(404);
    expect(mqState.published).toHaveLength(0);
  });

  it('refuses to update a transient model', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await patch({ type: 'pings', patch: { op: 'replace', path: [ 'note' ], value: [ 'x' ] } });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/transient \(create-only\)/);
  });

  /**
   * A write is row-checked against the object's CURRENT attributes, loaded
   * through the field cache rather than a full read.
   */
  it('403s an object owned by someone else, without reading the database', async () => {
    await serve(aclApp(ALLOW_OWN));
    await new NexxusModelFieldCache('m1', { userId: 'someone-else' }).save();

    const res = await patch({ type: 'runs', patch: { op: 'replace', path: [ 'note' ], value: [ 'x' ] } }, as());

    expect(res.status).toBe(403);
    expect(dbState.getItemsCalls).toHaveLength(0);
    expect(mqState.published).toHaveLength(0);
  });

  it('falls back to the database when the field cache misses', async () => {
    await serve(aclApp(ALLOW_OWN));
    dbState.getItemsResult = [ stored({ id: 'm1', type: 'runs', userId: 'u1' }) ];

    const res = await patch({ type: 'runs', patch: { op: 'replace', path: [ 'note' ], value: [ 'x' ] } }, as());

    expect(res.status).toBe(202);
    expect(dbState.getItemsCalls).toHaveLength(1);
  });

  it('403s when the object does not exist at all', async () => {
    await serve(aclApp(ALLOW_OWN));
    dbState.getItemsResult = [];

    // A 403 rather than a 404 — under a row constraint, "does not exist" and
    // "you may not see it" must be indistinguishable.
    expect((await patch({ type: 'runs', patch: { op: 'replace', path: [ 'note' ], value: [ 'x' ] } }, as())).status)
      .toBe(403);
  });
});

describe('DELETE /model/:id', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('publishes a delete to the writer', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await send('DELETE', '/model/m1', { type: 'runs' });

    expect(res.status).toBe(202);
    expect(mqState.published[0]).toMatchObject({
      queue: 'writer',
      message: { event: 'model_deleted', data: { id: 'm1', type: 'runs', appId: 'app1' } },
    });
  });

  it('404s a model the schema does not declare', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    expect((await send('DELETE', '/model/m1', { type: 'ghost' })).status).toBe(404);
    expect(mqState.published).toHaveLength(0);
  });

  it('refuses to delete a transient model', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    expect((await send('DELETE', '/model/m1', { type: 'pings' })).status).toBe(400);
  });

  it('records who asked for the delete', async () => {
    await serve(makeAuthApp({ schema: SCHEMA }));

    await send('DELETE', '/model/m1', { type: 'runs' }, as());

    // The writer needs the requester to fan the deletion out correctly.
    expect(mqState.published[0]!.message.data.userId).toBe('u1');
  });

  it('403s an object owned by someone else', async () => {
    await serve(aclApp(ALLOW_OWN));
    await new NexxusModelFieldCache('m1', { userId: 'someone-else' }).save();

    expect((await send('DELETE', '/model/m1', { type: 'runs' }, as())).status).toBe(403);
    expect(mqState.published).toHaveLength(0);
  });
});

describe('POST /model/:type/search', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('returns the matching items', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    dbState.searchResult = [ stored({ id: 'm1', type: 'runs', note: 'hi' }) ];

    const res = await send('POST', '/model/runs/search', {});

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it('applies the application default limit', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    await send('POST', '/model/runs/search', {});

    expect(dbState.searchCalls[0]).toMatchObject({ limit: 10, offset: 0 });
  });

  it('rejects a limit above the application maximum', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await send('POST', '/model/runs/search', { limit: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceeds maximum allowed value \(100\)/);
  });

  it('rejects a non-positive limit and a negative offset', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    expect((await send('POST', '/model/runs/search', { limit: 0 })).status).toBe(400);
    expect((await send('POST', '/model/runs/search', { limit: 'ten' })).status).toBe(400);
    expect((await send('POST', '/model/runs/search', { offset: -1 })).status).toBe(400);
  });

  it('narrows the query by the ACL row constraint', async () => {
    await serve(aclApp(ALLOW_OWN));

    await send('POST', '/model/runs/search', { filter: { note: 'hi' } }, as());

    // The constraint is ANDed into the DB filter, so the search can never
    // return rows the principal may not read.
    const filter = dbState.searchCalls[0].filter;

    expect(filter.test({ note: 'hi', userId: 'u1' })).toBe(true);
    expect(filter.test({ note: 'hi', userId: 'u2' })).toBe(false);
  });

  it('404s an unknown model', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    expect((await send('POST', '/model/ghost/search', {})).status).toBe(404);
  });
});

describe('POST /model/count', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('returns the count', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    dbState.countResult = 42;

    const res = await send('POST', '/model/count', { type: 'runs' });

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(42);
  });

  it('counts with no filter when the body carries none', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    await send('POST', '/model/count', { type: 'runs' });

    expect(dbState.searchCalls).toHaveLength(0);
  });

  it('404s an unknown model', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    expect((await send('POST', '/model/count', { type: 'ghost' })).status).toBe(404);
  });

  it('403s when no role allows counting', async () => {
    // `write` covers create/update/delete only. `read` would grant count —
    // count is one of the read actions, alongside get, search and subscribe.
    await serve(aclApp([ { effect: 'Allow', action: [ 'write' ], resource: [ 'runs' ] } ]));

    expect((await send('POST', '/model/count', { type: 'runs' }, as())).status).toBe(403);
  });

  it('is granted by the "read" action token', async () => {
    await serve(aclApp([ { effect: 'Allow', action: [ 'read' ], resource: [ 'runs' ] } ]));

    expect((await send('POST', '/model/count', { type: 'runs' }, as())).status).toBe(200);
  });

  it('folds userId into the count filter', async () => {
    await serve(makeAuthApp({ schema: SCHEMA }));
    dbState.countResult = 2;

    const res = await send('POST', '/model/count', { type: 'runs', userId: 'u1' }, as());

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
  });

  it('combines a filter and a userId', async () => {
    await serve(makeAuthApp({ schema: SCHEMA }));

    const res = await send('POST', '/model/count',
      { type: 'runs', userId: 'u1', filter: { note: 'hi' } }, as());

    expect(res.status).toBe(200);
  });

  /**
   * Count used to validate LESS than search, because it built its filter
   * through its own code path instead of the shared one. These three are the
   * checks it was missing.
   */
  it('rejects userId on an application without authentication', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await send('POST', '/model/count', { type: 'runs', userId: 'u1' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be used when authentication is disabled/);
  });

  it('rejects a non-string userId', async () => {
    await serve(makeAuthApp({ schema: SCHEMA }));

    expect((await send('POST', '/model/count', { type: 'runs', userId: 42 }, as())).status).toBe(400);
  });

  it('rejects a missing or non-string model type', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    for (const body of [ {}, { type: 42 } ]) {
      const res = await send('POST', '/model/count', body);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid model parameter/);
    }
  });

  /**
   * `id` is not part of count's contract — narrowing to one object makes a
   * count that can only be 0 or 1, which is `GET /model/:id` asked awkwardly.
   * The handler forwards `userId` and `filter` by name, so an invented `id`
   * never reaches the shared validator and can't quietly change the answer.
   */
  it('ignores an id a client invents rather than narrowing by it', async () => {
    await serve(makeAuthApp({ schema: SCHEMA }));
    dbState.countResult = 9;

    const res = await send('POST', '/model/count', { type: 'runs', id: 'm1' }, as());

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(9);
    expect(dbState.countResult).toBe(9);
  });

  it('does not reject id together with userId, since id is not a count parameter', async () => {
    // Search rejects that pair as redundant. Count never sees the `id` at all,
    // so there is no pair to be redundant.
    await serve(makeAuthApp({ schema: SCHEMA }));

    expect((await send('POST', '/model/count', { type: 'runs', id: 'm1', userId: 'u1' }, as())).status).toBe(200);
  });

  it('restates a bad filter as a parameter error', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await send('POST', '/model/count', { type: 'runs', filter: { ghost: 'x' } });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid filter parameter/);
  });

  /**
   * Count is gated at the ACTION level only — row conditions don't apply, per
   * the ACL design. A role restricted to its own rows still gets a full count.
   * Worth pinning because it differs from search, which IS row-narrowed.
   */
  it('does not narrow the count by the row constraint', async () => {
    await serve(aclApp(ALLOW_OWN));
    dbState.countResult = 7;

    const res = await send('POST', '/model/count', { type: 'runs' }, as());

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(7);
  });
});

describe('ModelRoute — route matching', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('matches /count as the literal route, not as an :id', async () => {
    // `POST /count` is registered BEFORE `POST /:type/search`, and `GET /:id`
    // would otherwise swallow it. Express matches in registration order, so
    // this ordering is load-bearing.
    await serve(makeApp({ schema: SCHEMA }));
    dbState.countResult = 3;

    expect((await send('POST', '/model/count', { type: 'runs' })).body.data.count).toBe(3);
  });

  it('requires the application header on every route', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    for (const [ method, path ] of [ [ 'POST', '/model' ], [ 'POST', '/model/count' ], [ 'DELETE', '/model/m1' ] ]) {
      expect((await send(method!, path!, { type: 'runs' }, {})).status).toBe(400);
    }
  });
});
