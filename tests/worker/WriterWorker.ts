import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NexxusWriterWorker, NexxusBaseWorker, NexxusWorkerUnsupportedEventException } from '@mayhem93/nexxus-worker-lib';
import { NexxusApplication, NexxusAppModel, UnknownApplicationException, UnknownModelTypeException } from '@mayhem93/nexxus-core-lib';
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
  logs: {
    fields: { line: { type: 'string' } },
    subscribable: false,
  },
};

const AUTH = { strategies: { local: {} }, userDetailSchema: { default: {} } };

/** Register an app in the worker's shared registry. `auth` gives it users; `acl` also turns on ACLs. */
const loadApp = (opts: { acl?: boolean; auth?: boolean } = {}): NexxusApplication => {
  const app = new NexxusApplication({
    id: 'app1', type: 'application', signingSecret: 's', name: 'A', schema: SCHEMA,
    ...(opts.acl ? { auth: { ...AUTH, acl: true } } : opts.auth ? { auth: AUTH } : {}),
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

  it('fails a message for an app it never loaded as terminal, so it is dead-lettered without retries', async () => {
    const err = await writer().processMessage(created()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnknownApplicationException);
    expect((err as UnknownApplicationException).terminal).toBe(true);
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
    expect([...call.options.returnFields]).not.toContain('userId'); // no users, so no owner
  });

  it('names the stored owner on the published patches, not whoever sent them', async () => {
    loadApp({ auth: true });
    dbState.updateResult = [{ id: 'r1', title: 'new title', count: 3, userId: 'owner-1' }];

    await writer().processMessage(updated());

    expect([...dbState.updateCalls[0].options.returnFields]).toContain('userId');
    // Both the caller's patch and the implicit updatedAt one.
    expect(mqState.published[0].message.data.map((p: any) => p.metadata.userId)).toEqual([ 'owner-1', 'owner-1' ]);
    // Named once, on `metadata`; the partial model keeps the rest.
    expect(mqState.published[0].message.data[0].metadata.partialModel).toEqual({ title: 'new title', count: 3 });
  });

  it('never names a userId the incoming patch carries', async () => {
    loadApp();

    // No users, so no owner to read back. An incoming `userId` could only name
    // whoever sent the patch.
    await writer().processMessage(updated([{
      op: 'replace', path: ['title'], value: ['new title'],
      metadata: { type: 'runs', id: 'r1', appId: 'app1', userId: 'actor-9' },
    }]));

    expect(mqState.published[0].message.data.map((p: any) => p.metadata.userId)).toEqual([ undefined, undefined ]);
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
    dbState.missingIds = [ 'r1' ];

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

  it('reads the stored owner back on an app with users, and names it on the event', async () => {
    loadApp({ auth: true });
    dbState.deleteResult = [{ id: 'r1', userId: 'owner-1', count: 3 }];

    await writer().processMessage(deleted());

    expect([ ...dbState.deleteOptions[0].returnFields ]).toContain('userId');
    // The owner is named once, on `data`; `partialModel` keeps the rest.
    expect(mqState.published[0].message.data).toEqual({
      id: 'r1', type: 'runs', appId: 'app1', userId: 'owner-1', partialModel: { count: 3 },
    });
  });

  it('never names a userId the incoming delete carries', async () => {
    loadApp();

    // No users, so no owner to read back. An incoming `userId` could only name
    // whoever asked for the delete.
    await writer().processMessage(deleted({ userId: 'actor-9' }));

    expect(mqState.published[0].message.data.userId).toBeUndefined();
  });

  it('reads the filterable fields back, and no owner, on an app without users', async () => {
    loadApp();

    await writer().processMessage(deleted());

    // The universal fields too: a filter can always test them.
    expect([ ...dbState.deleteOptions[0].returnFields ].sort()).toEqual([ 'count', 'createdAt', 'id', 'updatedAt' ]);
    expect(mqState.published[0].message.data.userId).toBeUndefined();
  });

  /**
   * A delete used to carry only the record's identity, so a filtered
   * subscription on any other field was never told.
   */
  it('hands the Transport Manager the filterable fields as they were before the delete', async () => {
    loadApp();
    dbState.deleteResult = [{ id: 'r1', count: 3 }];

    await writer().processMessage(deleted());

    // Exactly what was read back, without the id: that lives on data.id.
    expect(mqState.published[0].message.data.partialModel).toEqual({ count: 3 });
  });

  it('reads nothing back for a model nobody can subscribe to', async () => {
    loadApp({ auth: true });

    await writer().processMessage(deleted({ type: 'logs' }));

    // Not even the owner: there's no channel to route the delete to.
    expect(dbState.deleteOptions[0]).toEqual({});
  });

  it('dead-letters a delete for a model type the application does not declare, before deleting', async () => {
    loadApp();

    const err = await writer().processMessage(deleted({ type: 'ghost' })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnknownModelTypeException);
    expect((err as UnknownModelTypeException).terminal).toBe(true);
    expect(dbState.deleted).toHaveLength(0);
  });

  it('notifies nobody when the record was already deleted', async () => {
    loadApp({ auth: true });
    dbState.missingIds = [ 'r1' ];

    await writer().processMessage(deleted());

    expect(mqState.published).toHaveLength(0);
    expect(logger.has('info', /"r1" for appId: "app1" was already deleted, nothing to notify/)).toBe(true);
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
  it('fails an event it does not handle with a terminal error, so it is dead-lettered', async () => {
    const err = await writer().processMessage({ payload: { event: 'something_else' } })
      .catch((e: unknown) => e) as NexxusWorkerUnsupportedEventException;

    expect(err).toBeInstanceOf(NexxusWorkerUnsupportedEventException);
    expect(err.terminal).toBe(true);
    expect(err.message).toBe('The Writer doesn\'t handle "something_else" events');
    expect(dbState.created).toHaveLength(0);
  });
});

describe('NexxusWriterWorker publish resilience', () => {
  it('logs a transport-manager publish failure as an error and swallows it (the DB write stands)', async () => {
    loadApp();
    vi.spyOn(h.mq, 'publishMessage').mockRejectedValueOnce(new Error('broker down'));

    await expect(writer().processMessage(created())).resolves.toBeUndefined();

    expect(dbState.created).toHaveLength(1);
    // An error, not a warning: the event it carried is lost.
    expect(logger.has('error', /Publish to "transport-manager" failed for event "model_created" ; non-fatal: broker down/)).toBe(true);
  });
});
