import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NexxusApplication,
  NexxusUser,
  NexxusSetting,
  NexxusAppModel,
  NexxusJsonPatch,
  NexxusFilterQuery,
} from '@mayhem93/nexxus-core-lib';
import { errors } from '@elastic/elasticsearch';
import { NexxusElasticsearchDb } from '@mayhem93/nexxus-database-lib';
import { makeDb, logger } from './helpers';
import { state, resetEs } from './esFake';

const dbs: NexxusElasticsearchDb[] = [];
const db = () => { const d = makeDb(); dbs.push(d); return d; };
const client = (d: NexxusElasticsearchDb) => (d as unknown as { client: any }).client;

beforeEach(() => resetEs());
afterEach(async () => {
  for (const d of dbs) await d.disconnect().catch(() => {});
  dbs.length = 0;
});

// --- model + patch builders -------------------------------------------------
const appModel = (over: Record<string, unknown> = {}) =>
  NexxusAppModel.fromStorage({ id: 'r1', appId: 'app1', type: 'runs', ...over } as never);

const application = () => new NexxusApplication({ id: 'app1', type: 'application', name: 'App', schema: { runs: { fields: { note: { type: 'string' } } } } } as never);
const setting = () => new NexxusSetting({ id: 'pipeline', value: '{}' } as never);
const user = () => new NexxusUser({ appId: 'app1', username: 'u', authProviders: ['local'], devices: [], userType: 'default' } as never);

/** A validated replace patch on `runs.title` (app-model). */
const runPatch = () => {
  const p = new NexxusJsonPatch({ op: 'replace', path: ['title'], value: ['hello'], metadata: { type: 'runs', id: 'r1', appId: 'app1' } });

  p.validate({ title: { type: 'string' } } as never);

  return p;
};

const filter = (query: Record<string, unknown>) =>
  new NexxusFilterQuery(query as never, { status: { type: 'string', filterable: true }, count: { type: 'int', filterable: true }, tags: { type: 'array', arrayType: 'string', filterable: true } } as never);

describe('NexxusElasticsearchDb construction', () => {
  it('throws when the logger service is not a NexxusBaseLogger', () => {
    const services = { configManager: { getConfig: () => ({ host: 'h', port: 9200, user: 'u', password: 'p' }) }, logger: {} };

    expect(() => new NexxusElasticsearchDb(services as never)).toThrow(/Logger service is not properly initialized/);
  });
});

describe('NexxusElasticsearchDb connection state machine', () => {
  it('marks connected and emits connect on the first successful op', async () => {
    const d = db();
    let connected = false;

    d.on('connect', () => { connected = true; });
    await d.countItems({ type: 'application' });

    expect(connected).toBe(true);
  });

  it('marks disconnected and emits disconnect on a connection error', async () => {
    const d = db();
    let disconnected = false;

    d.on('disconnect', () => { disconnected = true; });
    await d.countItems({ type: 'application' }); // connect first

    vi.spyOn(client(d), 'count').mockRejectedValueOnce(new errors.ConnectionError('ES down'));
    await expect(d.countItems({ type: 'application' })).rejects.toThrow(/ES down/);

    expect(disconnected).toBe(true);
    expect(logger.has('warning', /connection error in countItems/)).toBe(true);
  });

  it('propagates a non-connection error without a disconnect', async () => {
    const d = db();
    let disconnected = false;

    await d.countItems({ type: 'application' });
    d.on('disconnect', () => { disconnected = true; });

    vi.spyOn(client(d), 'count').mockRejectedValueOnce(new Error('bad query'));
    await expect(d.countItems({ type: 'application' })).rejects.toThrow(/bad query/);

    expect(disconnected).toBe(false);
  });

  it('connect() resolves once ES answers the ping, disconnect() closes the client', async () => {
    const d = db();

    await d.connect();
    await d.disconnect();

    expect(state.calls.close).toBeGreaterThanOrEqual(1);
  });
});

describe('NexxusElasticsearchDb.createItems', () => {
  it('routes a builtin (application) to its index with wait_for', async () => {
    await db().createItems([application()]);

    const req = state.calls.bulk[0];

    expect(req.operations[0]).toEqual({ index: { _index: 'nxx-application', _id: 'app1' } });
    expect(req.refresh).toBe('wait_for');
  });

  it('routes an app model to its per-app index with refresh:false and back-fills the version', async () => {
    const model = appModel();

    state.bulkResult = { errors: false, items: [{ index: { _version: 7 } }] };
    await db().createItems([model]);

    const req = state.calls.bulk[0];

    expect(req.operations[0]).toEqual({ index: { _index: 'nxx-app-app1-runs', _id: 'r1' } });
    expect(req.refresh).toBe(false);
    expect((model.getData() as { version?: number }).version).toBe(7);
  });

  it('routes users and settings to the right indices', async () => {
    await db().createItems([user(), setting()]);

    const ops = state.calls.bulk[0].operations;

    expect(ops[0].index._index).toBe('nxx-app-app1-user');
    expect(ops[2].index._index).toBe('nxx-setting');
  });

  it('throws on an unsupported model type', async () => {
    const bogus = { getData: () => ({ type: 'weird', id: 'x' }) };

    await expect(db().createItems([bogus as never])).rejects.toThrow(/Unsupported model type: weird/);
  });

  it('logs when the bulk response reports errors', async () => {
    state.bulkResult = { errors: true, items: [{ index: { error: { type: 'mapper_parsing_exception' } } }] };
    await db().createItems([application()]);

    expect(logger.has('error', /Failed to create items/)).toBe(true);
  });
});

describe('NexxusElasticsearchDb.searchItems', () => {
  it('maps hits to Application instances', async () => {
    state.searchResult = { hits: { hits: [{ _source: { id: 'app1', type: 'application', name: 'A', schema: { runs: { fields: { n: { type: 'string' } } } } } }] } };

    const results = await db().searchItems({ type: 'application' });

    expect(results).toHaveLength(1);
    expect(results[0]).toBeInstanceOf(NexxusApplication);
  });

  it('hydrates app models via fromStorage, injecting the ES _version', async () => {
    state.searchResult = { hits: { hits: [{ _source: { id: 'r1', appId: 'app1', type: 'runs', title: 'x' }, _version: 4 }] } };

    const results = await db().searchItems({ type: 'runs', appId: 'app1' });

    expect(results[0]).toBeInstanceOf(NexxusAppModel);
    expect((results[0].getData() as { version?: number }).version).toBe(4);
  });

  it('force-refreshes the index before an app-model search when requested', async () => {
    await db().searchItems({ type: 'runs', appId: 'app1', databaseSpecific: { forceRefresh: true } });

    expect(state.calls.refresh[0]).toEqual({ index: 'nxx-app-app1-runs' });
  });

  it('constructs user and setting models from hits', async () => {
    state.searchResult = { hits: { hits: [{ _source: { appId: 'app1', type: 'user', username: 'u', authProviders: ['local'], devices: [], userType: 'default' } }] } };
    expect((await db().searchItems({ type: 'user', appId: 'app1' }))[0]).toBeInstanceOf(NexxusUser);

    resetEs();
    state.searchResult = { hits: { hits: [{ _source: { id: 'pipeline', type: 'setting', value: '{}' } }] } };
    expect((await db().searchItems({ type: 'setting' }))[0]).toBeInstanceOf(NexxusSetting);
  });
});

describe('NexxusElasticsearchDb.getItems', () => {
  it('mgets and maps found docs, dropping missing/errored ones', async () => {
    state.mget = () => ({
      docs: [
        { found: true, _source: { id: 'app1', type: 'application', name: 'A', schema: { runs: { fields: { n: { type: 'string' } } } } } },
        { found: false, _id: 'missing' },
        { error: { type: 'x' }, _id: 'boom' },
      ],
    });

    const results = await db().getItems({ type: 'application', ids: ['app1', 'missing', 'boom'] });

    expect(results).toHaveLength(1);
    expect(state.calls.mget[0].index).toBe('nxx-application');
    expect(logger.has('warning', /Error retrieving document/)).toBe(true);
  });

  it('routes a user get to the per-app user index and constructs a NexxusUser', async () => {
    state.mget = () => ({ docs: [{ found: true, _source: { appId: 'app1', type: 'user', username: 'u', authProviders: ['local'], devices: [], userType: 'default' } }] });

    const results = await db().getItems({ type: 'user', ids: ['u1'], appId: 'app1' });

    expect(state.calls.mget[0].index).toBe('nxx-app-app1-user');
    expect(results[0]).toBeInstanceOf(NexxusUser);
  });

  it('requires an appId for user and app-model gets', async () => {
    await expect(db().getItems({ type: 'user', ids: ['u1'] })).rejects.toThrow(/App ID is required/);
    await expect(db().getItems({ type: 'runs', ids: ['r1'] })).rejects.toThrow(/App ID is required/);
  });

  it('treats a 404 (index absent) as an empty result', async () => {
    const d = db();

    vi.spyOn(client(d), 'mget').mockRejectedValueOnce(new errors.ResponseError({ statusCode: 404, warnings: [], meta: {} as never, body: {} }));

    expect(await d.getItems({ type: 'runs', ids: ['r1'], appId: 'app1' })).toEqual([]);
  });
});

describe('NexxusElasticsearchDb.updateItems', () => {
  it('uses wait_for for built-in updates (regression: was always refresh:false)', async () => {
    const p = new NexxusJsonPatch({ op: 'replace', path: ['name'], value: ['New'], metadata: { type: 'application', id: 'app1', appId: 'app1' } });

    p.validate({ name: { type: 'string' } } as never);
    await db().updateItems([p]);

    expect(state.calls.bulk[0].refresh).toBe('wait_for');
  });

  it('uses refresh:false for app-model updates', async () => {
    await db().updateItems([runPatch()]);

    expect(state.calls.bulk[0].refresh).toBe(false);
  });

  it('compiles a replace into a painless script targeting the right doc', async () => {
    await db().updateItems([runPatch()]);

    const ops = state.calls.bulk[0].operations;

    expect(ops[0]).toEqual({ update: { _index: 'nxx-app-app1-runs', _id: 'r1', retry_on_conflict: 3 } });
    expect(ops[1].script.source).toBe('ctx._source.title = params.value0');
    expect(ops[1].script.params).toEqual({ value0: 'hello' });
  });

  it('compiles append/prepend/decr into the right painless fragments', async () => {
    const mk = (op: string, path: string[], value: unknown[], schema: Record<string, unknown>) => {
      const p = new NexxusJsonPatch({ op: op as never, path, value, metadata: { type: 'runs', id: 'r1', appId: 'app1' } });

      p.validate(schema as never);

      return p;
    };

    await db().updateItems([
      mk('append', ['tags'], ['x'], { tags: { type: 'array', arrayType: 'string' } }),
      mk('prepend', ['tags'], ['y'], { tags: { type: 'array', arrayType: 'string' } }),
      mk('decr', ['count'], [2], { count: { type: 'int' } }),
    ]);

    const src = state.calls.bulk[0].operations[1].script.source;

    expect(src).toContain('ctx._source.tags.add(params.');
    expect(src).toContain('ctx._source.tags.add(0, params.');
    expect(src).toContain('ctx._source.count -= params.');
  });

  it('merges multiple patches on the same doc into one update action', async () => {
    const p1 = new NexxusJsonPatch({ op: 'replace', path: ['title'], value: ['a'], metadata: { type: 'runs', id: 'r1', appId: 'app1' } });
    const p2 = new NexxusJsonPatch({ op: 'incr', path: ['count'], value: [1], metadata: { type: 'runs', id: 'r1', appId: 'app1' } });

    p1.validate({ title: { type: 'string' } } as never);
    p2.validate({ count: { type: 'int' } } as never);

    await db().updateItems([p1, p2]);

    // one update action (two operations: header + body), not two
    expect(state.calls.bulk[0].operations).toHaveLength(2);
    expect(state.calls.bulk[0].operations[1].script.source).toContain('ctx._source.title = params.value0');
    expect(state.calls.bulk[0].operations[1].script.source).toContain('ctx._source.count += params.value1');
  });

  it('returns partial models (id + version + returned fields) for successful updates', async () => {
    state.bulkResult = { items: [{ update: { status: 200, _id: 'r1', _version: 9, get: { _source: { title: 'hello' } } } }] };

    const result = await db().updateItems([runPatch()]);

    expect(result).toEqual([{ id: 'r1', title: 'hello', version: 9 }]);
  });

  it('returns [] and warns when no valid patches produce script lines', async () => {
    // A valid incr patch (int field), then corrupt the recorded field type so
    // updateItems' switch hits the "incr not supported for this type" branch and
    // emits no script line → empty bulk.
    const p = new NexxusJsonPatch({ op: 'incr', path: ['count'], value: [1], metadata: { type: 'runs', id: 'r1', appId: 'app1' } });

    p.validate({ count: { type: 'int' } } as never);
    (p.get().metadata as { pathFieldTypes: string[] }).pathFieldTypes = ['string'];

    expect(await db().updateItems([p])).toEqual([]);
    expect(logger.has('warning', /No items to update/)).toBe(true);
  });

  it('throws when a non-builtin patch is missing its appId', async () => {
    const p = new NexxusJsonPatch({ op: 'replace', path: ['title'], value: ['x'], metadata: { type: 'runs', id: 'r1', appId: 'app1' } });

    p.validate({ title: { type: 'string' } } as never);
    (p.get().metadata as { appId?: string }).appId = undefined; // simulate a missing appId at the DB layer

    await expect(db().updateItems([p])).rejects.toThrow(/App ID is required/);
  });
});

describe('NexxusElasticsearchDb.deleteItems + countItems', () => {
  it('routes deletes to the right indices', async () => {
    await db().deleteItems([application(), setting(), user(), appModel()]);

    const ops = state.calls.bulk[0].operations;

    expect(ops[0]).toEqual({ delete: { _index: 'nxx-application', _id: 'app1' } });
    expect(ops[1]).toEqual({ delete: { _index: 'nxx-setting', _id: 'pipeline' } });
    expect(ops[2].delete._index).toBe('nxx-app-app1-user');
    expect(ops[3]).toEqual({ delete: { _index: 'nxx-app-app1-runs', _id: 'r1' } });
  });

  it('countItems returns the ES count', async () => {
    state.countResult = { count: 12 };

    expect(await db().countItems({ type: 'application' })).toBe(12);
  });
});

describe('NexxusElasticsearchDb.buildQuery + filter DSL', () => {
  it('throws when an app-scoped search is missing its appId', async () => {
    await expect(db().searchItems({ type: 'runs' })).rejects.toThrow(/App ID is required/);
  });

  it('defaults paging + sort and match_all when no filter is given', async () => {
    await db().searchItems({ type: 'application' });

    const req = state.calls.search[0];

    expect(req).toMatchObject({ index: 'nxx-application', from: 0, size: 100, query: { match_all: {} }, sort: { updatedAt: { order: 'desc' } } });
  });

  it('translates each operator to the right ES query clause', async () => {
    await db().countItems({ type: 'runs', appId: 'app1', filter: filter({ status: 'active' }) });
    expect(state.calls.count[0].query).toEqual({ bool: { must: [{ term: { status: 'active' } }] } });

    await db().countItems({ type: 'runs', appId: 'app1', filter: filter({ count: { gt: 5 } }) });
    expect(state.calls.count[1].query.bool.must[0]).toEqual({ range: { count: { gt: 5 } } });

    await db().countItems({ type: 'runs', appId: 'app1', filter: filter({ status: { ne: 'x' } }) });
    expect(state.calls.count[2].query.bool.must[0]).toEqual({ bool: { must_not: { term: { status: 'x' } } } });

    await db().countItems({ type: 'runs', appId: 'app1', filter: filter({ tags: { in: ['a', 'b'] } }) });
    expect(state.calls.count[3].query.bool.must[0]).toEqual({ terms: { tags: ['a', 'b'] } });
  });

  it('nests a $or as a should clause with minimum_should_match', async () => {
    await db().countItems({ type: 'runs', appId: 'app1', filter: filter({ $or: [{ status: 'a' }, { status: 'b' }] }) });

    const or = state.calls.count[0].query.bool.must[0].bool;

    expect(or.minimum_should_match).toBe(1);
    expect(or.should).toEqual([{ term: { status: 'a' } }, { term: { status: 'b' } }]);
  });

  it('handles a $and containing a nested $or', async () => {
    await db().countItems({
      type: 'runs',
      appId: 'app1',
      filter: filter({ $and: [{ status: 'a' }, { $or: [{ count: { gt: 1 } }, { count: { lt: 5 } }] }] }),
    });

    const outer = state.calls.count[0].query.bool.must[0].bool; // the $and bool
    const inner = outer.must.find((c: any) => c.bool?.should)?.bool; // the nested $or

    expect(outer.must).toContainEqual({ term: { status: 'a' } });
    expect(inner.should).toEqual([{ range: { count: { gt: 1 } } }, { range: { count: { lt: 5 } } }]);
  });
});

describe('NexxusElasticsearchDb.getStats', () => {
  it('assembles a cluster + indices snapshot', async () => {
    state.health = { cluster_name: 'nxx-cluster', status: 'green', number_of_nodes: 3 };
    state.catIndices = [{ index: 'nxx-application', 'docs.count': '5', 'store.size': '1024', health: 'green' }];

    const stats = await db().getStats();

    expect(stats).toEqual({
      id: 'nxx-cluster',
      connected: true,
      clusterName: 'nxx-cluster',
      clusterStatus: 'green',
      numberOfNodes: 3,
      indices: [{ name: 'nxx-application', docCount: 5, sizeBytes: 1024, health: 'green' }],
    });
  });

  it('returns disconnected when the cluster call throws', async () => {
    const d = db();

    client(d).cluster.health.mockRejectedValueOnce(new errors.ConnectionError('unreachable'));

    expect(await d.getStats()).toEqual({ id: 'unknown', connected: false });
  });
});
