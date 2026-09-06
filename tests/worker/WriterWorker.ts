import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NexxusWriterWorker, NexxusBaseWorker } from '@mayhem93/nexxus-worker-lib';
import { NexxusApplication, NexxusAppModel } from '@mayhem93/nexxus-core-lib';
import { NexxusModelFieldCache } from '@mayhem93/nexxus-redis';
import { makeHarness, logger, dbState, mqState, resetWorkerStatics, type WorkerHarness } from './harness';

const workers: NexxusWriterWorker[] = [];
let h: WorkerHarness;

beforeEach(async () => {
  resetWorkerStatics(NexxusBaseWorker);
  h = await makeHarness();
});

afterEach(async () => {
  for (const w of workers) await w.close().catch(() => {});
  workers.length = 0;
});

const writer = (): any => {
  const w = new NexxusWriterWorker(h.services);

  workers.push(w);

  return w;
};

/* --- fixtures --------------------------------------------------------- */
const SCHEMA = {
  runs: {
    fields: {
      title: { type: 'string' },
      count: { type: 'int', filterable: true },
      owner: { type: 'string', acl: true },
    },
  },
};

const AUTH = { jwtSecret: 's', strategies: { local: {} }, userDetailSchema: { default: {} } };

/** Register an app in the worker's shared registry. `acl` turns on ACLs. */
const loadApp = (opts: { acl?: boolean } = {}): NexxusApplication => {
  const app = new NexxusApplication({
    id: 'app1', type: 'application', name: 'A', schema: SCHEMA,
    ...(opts.acl ? { auth: { ...AUTH, acl: true } } : {}),
  } as never);

  (NexxusBaseWorker as any).loadedApps.set('app1', app);

  return app;
};

const created = (over: Record<string, unknown> = {}) => ({
  payload: { event: 'model_created', data: { id: 'r1', appId: 'app1', type: 'runs', title: 'hello', ...over } },
});

const deleted = (over: Record<string, unknown> = {}) => ({
  payload: { event: 'model_deleted', data: { id: 'r1', appId: 'app1', type: 'runs', ...over } },
});

const updated = (patches?: any[]) => ({
  payload: {
    event: 'model_updated',
    data: patches ?? [{
      op: 'replace', path: ['title'], value: ['new title'],
      metadata: { type: 'runs', id: 'r1', appId: 'app1' },
    }],
  },
});

/** The field-cache HASH for a model id, as stored in the in-memory redis. */
const cacheEntry = (id: string) =>
  h.redisClient.store.get(NexxusModelFieldCache.getKey(id)) as { value: Map<string, string> } | undefined;

const cachedFields = (id: string): Record<string, unknown> | undefined => {
  const e = cacheEntry(id);

  return e ? Object.fromEntries([...e.value].map(([k, v]) => [k, JSON.parse(v)])) : undefined;
};

describe('NexxusWriterWorker model_created', () => {
  it('validates, writes to the database and notifies the transport manager', async () => {
    loadApp();

    await writer().processMessage(created());

    const model = dbState.created[0][0];

    expect(model).toBeInstanceOf(NexxusAppModel);
    expect(model.getData()).toMatchObject({ id: 'r1', appId: 'app1', type: 'runs', title: 'hello' });

    expect(mqState.published[0].queue).toBe('transport-manager');
    expect(mqState.published[0].message.event).toBe('model_created');
    expect(mqState.published[0].message.data).toMatchObject({ id: 'r1', title: 'hello' });
  });

  it('throws when the app is not loaded', async () => {
    await expect(writer().processMessage(created())).rejects.toThrow(/App not found for model_created: appId=app1/);
  });

  it('rejects a payload that fails schema validation', async () => {
    loadApp();

    await expect(writer().processMessage(created({ title: 123 }))).rejects.toThrow(/Expected string/);
  });

  it('projects the ACL fields into the field cache when ACLs are on', async () => {
    loadApp({ acl: true });

    await writer().processMessage(created({ owner: 'u1', userId: 'u1' }));

    expect(cachedFields('r1')).toMatchObject({ id: 'r1', owner: 'u1', userId: 'u1' });
    expect(cachedFields('r1')).toHaveProperty('createdAt');
  });

  it('omits userId from the cache when the model has none', async () => {
    loadApp({ acl: true });

    await writer().processMessage(created({ owner: 'u1' }));

    expect(cachedFields('r1')).not.toHaveProperty('userId');
  });

  it('writes no cache entry when ACLs are off', async () => {
    loadApp();

    await writer().processMessage(created({ owner: 'u1' }));

    expect(cacheEntry('r1')).toBeUndefined();
  });

  it('treats a field-cache failure as non-fatal', async () => {
    loadApp({ acl: true });
    h.redisClient.hSet = async () => { throw new Error('redis down'); };

    await expect(writer().processMessage(created({ owner: 'u1' }))).resolves.toBeUndefined();
    expect(dbState.created).toHaveLength(1); // the DB write still stands
    expect(logger.has('warning', /Field cache op failed \(create cache for "r1"\) — non-fatal: redis down/)).toBe(true);
  });
});

describe('NexxusWriterWorker model_updated', () => {
  beforeEach(() => { dbState.updateResult = [{ id: 'r1', title: 'new title', count: 3 }]; });

  it('adds an implicit updatedAt patch and requests the filterable fields back', async () => {
    loadApp();

    await writer().processMessage(updated());

    const call = dbState.updateCalls[0];

    expect(call.patches).toHaveLength(2); // the caller's patch + the implicit updatedAt
    expect(call.patches[1].get().path).toEqual(['updatedAt']);
    expect([...call.options.returnFields]).toContain('count'); // filterable field
  });

  it('publishes both patches with the partial model, stripped of internals', async () => {
    loadApp();

    await writer().processMessage(updated());

    const published = mqState.published[0].message;

    expect(published.event).toBe('model_updated');
    expect(published.data).toHaveLength(2);

    for (const entry of published.data) {
      expect(entry.metadata.pathFieldTypes).toBeUndefined(); // internal, stripped
      expect(entry.metadata.partialModel).toMatchObject({ title: 'new title', count: 3 });
      expect(entry.metadata.partialModel.id).toBeUndefined(); // id lives on metadata.id
    }
  });

  it('throws when the patch targets an app that is not loaded', async () => {
    await expect(writer().processMessage(updated())).rejects.toThrow(/App not found for model_updated: appId=app1/);
  });

  it('warns and publishes nothing when the target document does not exist', async () => {
    loadApp();
    dbState.updateResult = [];

    await writer().processMessage(updated());

    expect(logger.has('warning', /No item found to update .* id r1/)).toBe(true);
    expect(mqState.published).toHaveLength(0);
  });

  it('write-throughs only the ACL fields the patch actually touched', async () => {
    loadApp({ acl: true });
    dbState.updateResult = [{ id: 'r1', owner: 'u2', count: 3 }];

    await writer().processMessage(updated([{
      op: 'replace', path: ['owner'], value: ['u2'],
      metadata: { type: 'runs', id: 'r1', appId: 'app1' },
    }]));

    expect(cachedFields('r1')).toEqual({ owner: 'u2' }); // count is filterable, not acl
  });

  it('skips the cache when the patch touches no ACL field', async () => {
    loadApp({ acl: true });
    dbState.updateResult = [{ id: 'r1', title: 'new title' }];

    await writer().processMessage(updated());

    expect(cacheEntry('r1')).toBeUndefined();
  });

  it('requests the ACL fields back alongside the filterable ones', async () => {
    loadApp({ acl: true });

    await writer().processMessage(updated());

    expect([...dbState.updateCalls[0].options.returnFields]).toContain('owner');
  });
});

describe('NexxusWriterWorker model_deleted', () => {
  it('deletes from the database and notifies the transport manager', async () => {
    loadApp();

    await writer().processMessage(deleted());

    expect(dbState.deleted[0][0]).toBeInstanceOf(NexxusAppModel);
    expect(dbState.deleted[0][0].getData()).toMatchObject({ id: 'r1', appId: 'app1', type: 'runs' });
    expect(mqState.published[0].message).toMatchObject({ event: 'model_deleted', data: { id: 'r1' } });
  });

  it('does not re-validate the payload against the schema', async () => {
    loadApp();

    // `title` is the wrong type, but a delete only needs id/appId/type.
    await expect(writer().processMessage(deleted({ title: 123 }))).resolves.toBeUndefined();
    expect(dbState.deleted).toHaveLength(1);
  });

  it('throws when the app is not loaded', async () => {
    await expect(writer().processMessage(deleted())).rejects.toThrow(/App not found for model_deleted: appId=app1/);
  });

  it('removes the field cache entry when ACLs are on', async () => {
    loadApp({ acl: true });
    await new NexxusModelFieldCache('r1', { owner: 'u1' }).save();
    expect(cacheEntry('r1')).toBeDefined();

    await writer().processMessage(deleted());

    expect(cacheEntry('r1')).toBeUndefined();
  });

  it('treats a field-cache removal failure as non-fatal', async () => {
    loadApp({ acl: true });
    h.redisClient.unlink = async () => { throw new Error('redis down'); };

    await expect(writer().processMessage(deleted())).resolves.toBeUndefined();
    expect(logger.has('warning', /Field cache op failed \(delete cache for "r1"\)/)).toBe(true);
  });
});

describe('NexxusWriterWorker unknown events', () => {
  it('warns and drops an event it does not handle', async () => {
    await writer().processMessage({ payload: { event: 'something_else' } });

    expect(logger.has('warning', /Unknown event type: something_else/)).toBe(true);
    expect(dbState.created).toHaveLength(0);
  });
});

describe('NexxusWriterWorker publish resilience', () => {
  it('logs and swallows a transport-manager publish failure (the DB write stands)', async () => {
    loadApp();
    vi.spyOn(h.mq, 'publishMessage').mockRejectedValueOnce(new Error('broker down'));

    await expect(writer().processMessage(created())).resolves.toBeUndefined();

    expect(dbState.created).toHaveLength(1);
    expect(logger.has('warning', /Publish to "transport-manager" failed for event "model_created" ; non-fatal: broker down/)).toBe(true);
  });
});
