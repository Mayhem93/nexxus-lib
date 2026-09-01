import { describe, it, expect, beforeEach } from 'vitest';
import { NexxusApplication, NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';
import { makeDb } from './helpers';
import { state, resetEs } from './esFake';

beforeEach(() => resetEs());

const bootstrapper = () => makeDb().getBootstrapper();

/** The mappings passed to indices.create for a given index (or undefined). */
const createdMapping = (index: string): any =>
  state.calls.indicesCreate.find(c => c.index === index)?.mappings;

const createdIndexNames = (): string[] => state.calls.indicesCreate.map(c => c.index);

describe('NexxusElasticsearchDbBootstrapper.bootstrapDeployment', () => {
  it('creates the application and setting indices', async () => {
    await bootstrapper().bootstrapDeployment();

    expect(createdIndexNames()).toEqual([`${NEXXUS_PREFIX_LC}-application`, `${NEXXUS_PREFIX_LC}-setting`]);
  });

  it('marks the application schema/auth blobs as non-indexed and includes framework fields', async () => {
    await bootstrapper().bootstrapDeployment();

    const mapping = createdMapping(`${NEXXUS_PREFIX_LC}-application`);

    expect(mapping.properties.schema).toEqual({ type: 'object', enabled: false });
    expect(mapping.properties.auth).toEqual({ type: 'object', enabled: false });
    expect(mapping.properties.type).toEqual({ type: 'keyword' });
    expect(mapping.properties.id).toEqual({ type: 'keyword' });      // universal field
    expect(mapping.properties.createdAt).toEqual({ type: 'date' });  // universal field
    expect(mapping.dynamic_templates).toHaveLength(3);
  });

  it('is idempotent — skips indices that already exist', async () => {
    state.existsResult = true;

    await bootstrapper().bootstrapDeployment();

    expect(state.calls.indicesCreate).toHaveLength(0);
  });
});

describe('NexxusElasticsearchDbBootstrapper.onApplicationCreated', () => {
  const appWith = (schema: Record<string, unknown>, auth?: Record<string, unknown>) => new NexxusApplication({
    id: 'app1', type: 'application', name: 'App', schema, ...(auth ? { auth } : {}),
  } as never);

  it('maps every Nexxus field type to the right ES mapping', async () => {
    const app = appWith({
      events: {
        fields: {
          title:  { type: 'string' },
          count:  { type: 'int' },
          ratio:  { type: 'float' },
          active: { type: 'boolean' },
          when:   { type: 'date' },
          tags:   { type: 'array', arrayType: 'string' },
          items:  { type: 'array', arrayType: 'object', properties: { name: { type: 'string' } } },
          rawlog: { type: 'array', arrayType: 'object' }, // no properties → bare object
          meta:   { type: 'object', properties: { region: { type: 'string' } } },
        },
      },
    });

    await bootstrapper().onApplicationCreated(app);

    const p = createdMapping(`${NEXXUS_PREFIX_LC}-app-app1-events`).properties;

    expect(p.title).toEqual({ type: 'keyword' });
    expect(p.count).toEqual({ type: 'long' });
    expect(p.ratio).toEqual({ type: 'double' });
    expect(p.active).toEqual({ type: 'boolean' });
    expect(p.when).toEqual({ type: 'date' });
    expect(p.tags).toEqual({ type: 'keyword' });                                  // primitive-array → element mapping
    expect(p.items).toEqual({ properties: { name: { type: 'keyword' } } });        // object-array with props
    expect(p.rawlog).toEqual({ type: 'object' });                                  // object-array without props
    expect(p.meta).toEqual({ properties: { region: { type: 'keyword' } } });       // object with props
    // app-model framework fields
    expect(p.appId).toEqual({ type: 'keyword' });
    expect(p.userId).toEqual({ type: 'keyword' });
  });

  it('skips transient models', async () => {
    const app = appWith({
      runs:    { fields: { note: { type: 'string' } } },
      notify:  { fields: { msg: { type: 'string' } }, transient: true },
    });

    await bootstrapper().onApplicationCreated(app);

    expect(createdIndexNames()).toContain(`${NEXXUS_PREFIX_LC}-app-app1-runs`);
    expect(createdIndexNames()).not.toContain(`${NEXXUS_PREFIX_LC}-app-app1-notify`);
  });

  it('creates a user index only when auth is enabled', async () => {
    await bootstrapper().onApplicationCreated(appWith({ runs: { fields: { note: { type: 'string' } } } }));
    expect(createdIndexNames()).not.toContain(`${NEXXUS_PREFIX_LC}-app-app1-user`);

    resetEs();

    await bootstrapper().onApplicationCreated(appWith(
      { runs: { fields: { note: { type: 'string' } } } },
      { jwtSecret: 's', strategies: { local: {} }, userDetailSchema: { default: {} } },
    ));
    expect(createdIndexNames()).toContain(`${NEXXUS_PREFIX_LC}-app-app1-user`);
  });

  it('creates an acl index only when ACLs are enabled', async () => {
    await bootstrapper().onApplicationCreated(appWith(
      { runs: { fields: { note: { type: 'string' } } } },
      { jwtSecret: 's', strategies: { local: {} }, userDetailSchema: { default: {} }, acl: true },
    ));

    expect(createdIndexNames()).toContain(`${NEXXUS_PREFIX_LC}-app-app1-acl`);
  });
});
