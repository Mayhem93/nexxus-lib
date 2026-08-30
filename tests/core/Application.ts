import { describe, it, expect } from 'vitest';
import { NexxusApplication, DEFAULT_ACL_ROLE_ID, type INexxusApplication } from '@mayhem93/nexxus-core-lib';

/** A valid minimal application document, with per-test overrides. */
const makeData = (overrides: Record<string, unknown> = {}): INexxusApplication => ({
  id: 'app1',
  type: 'application',
  name: 'Test App',
  schema: { runs: { fields: { note: { type: 'string', required: false } } } },
  ...overrides,
} as INexxusApplication);

/** Valid minimal auth block, with per-test overrides. */
const withAuth = (authOverrides: Record<string, unknown> = {}): INexxusApplication => makeData({
  auth: { jwtSecret: 'secret', strategies: { local: {} }, userDetailSchema: { default: {} }, ...authOverrides },
});

describe('NexxusApplication constructor', () => {
  it('constructs a minimal valid app and forces type=application', () => {
    const app = new NexxusApplication(makeData());

    expect(app.getData().type).toBe('application');
    expect(app.getData().name).toBe('Test App');
  });

  it('defaults defaultLimit=10 and maxLimit=100', () => {
    const app = new NexxusApplication(makeData());

    expect(app.getData().defaultLimit).toBe(10);
    expect(app.getData().maxLimit).toBe(100);
  });

  it('defaults subscribable=true and transient=false per model', () => {
    const app = new NexxusApplication(makeData());

    expect(app.isSubscribable('runs')).toBe(true);
    expect(app.isTransient('runs')).toBe(false);
  });

  it('rejects an empty schema', () => {
    expect(() => new NexxusApplication(makeData({ schema: {} }))).toThrow(/schema cannot be empty/);
  });

  it('rejects a reserved app-scoped model name (acl / user)', () => {
    expect(() => new NexxusApplication(makeData({ schema: { acl: { fields: {} } } })))
      .toThrow(/reserved app-scoped built-in/);
    expect(() => new NexxusApplication(makeData({ schema: { user: { fields: {} } } })))
      .toThrow(/reserved app-scoped built-in/);
  });

  it('rejects a schema entry that is not an object', () => {
    expect(() => new NexxusApplication(makeData({ schema: { runs: null } }))).toThrow(/must be an object/);
  });

  it('rejects a model without a fields object', () => {
    expect(() => new NexxusApplication(makeData({ schema: { runs: {} } }))).toThrow(/must have a "fields" object/);
  });

  it('rejects the invalid subscribable=false + transient=true combo', () => {
    expect(() => new NexxusApplication(makeData({
      schema: { runs: { fields: { note: { type: 'string' } }, subscribable: false, transient: true } },
    }))).toThrow(/cannot be both non-subscribable and transient/);
  });

  it('rejects a non-boolean subscribable / transient flag', () => {
    expect(() => new NexxusApplication(makeData({ schema: { runs: { fields: { note: { type: 'string' } }, subscribable: 'x' } } })))
      .toThrow(/"subscribable" must be a boolean/);
    expect(() => new NexxusApplication(makeData({ schema: { runs: { fields: { note: { type: 'string' } }, transient: 'x' } } })))
      .toThrow(/"transient" must be a boolean/);
  });

  it('rejects a reserved field name in a model', () => {
    expect(() => new NexxusApplication(makeData({
      schema: { runs: { fields: { userId: { type: 'string' } } } },
    }))).toThrow(/Nexxus-reserved name/);
  });

  it('requires a name', () => {
    expect(() => new NexxusApplication(makeData({ name: undefined }))).toThrow(/"name" is required/);
  });

  it('rejects defaultLimit <= 10', () => {
    expect(() => new NexxusApplication(makeData({ defaultLimit: 5 }))).toThrow(/defaultLimit/);
  });

  it('rejects maxLimit below defaultLimit', () => {
    expect(() => new NexxusApplication(makeData({ defaultLimit: 20, maxLimit: 15 }))).toThrow(/maxLimit/);
  });

  it('rejects a non-string description', () => {
    expect(() => new NexxusApplication(makeData({ description: 123 }))).toThrow(/"description" must be a string/);
  });
});

describe('NexxusApplication auth + acl', () => {
  it('requires jwtSecret when auth is provided', () => {
    expect(() => new NexxusApplication(makeData({ auth: { strategies: { local: {} }, userDetailSchema: {} } })))
      .toThrow(/jwtSecret/);
  });

  it('requires a non-empty strategies map', () => {
    expect(() => new NexxusApplication(withAuth({ strategies: {} }))).toThrow(/strategies/);
  });

  it('requires userDetailSchema', () => {
    expect(() => new NexxusApplication(makeData({ auth: { jwtSecret: 's', strategies: { local: {} } } })))
      .toThrow(/userDetailSchema/);
  });

  it('force-injects the default user type with the framework default role', () => {
    const app = new NexxusApplication(withAuth());

    expect(app.getUserTypes()?.default).toEqual({ roles: [DEFAULT_ACL_ROLE_ID] });
  });

  it('preserves operator-supplied user types and still injects default', () => {
    const app = new NexxusApplication(withAuth({ userTypes: { driver: { roles: ['DriverRole'] } } }));
    const userTypes = app.getUserTypes()!;

    expect(userTypes.driver).toEqual({ roles: ['DriverRole'] });
    expect(userTypes.default).toEqual({ roles: [DEFAULT_ACL_ROLE_ID] });
  });

  it('defaults auth.acl to false → isAclEnabled() is false', () => {
    expect(new NexxusApplication(withAuth()).isAclEnabled()).toBe(false);
  });

  it('isAclEnabled() is true when auth.acl is true', () => {
    expect(new NexxusApplication(withAuth({ acl: true })).isAclEnabled()).toBe(true);
  });

  it('rejects a non-boolean auth.acl', () => {
    expect(() => new NexxusApplication(withAuth({ acl: 'yes' }))).toThrow(/"auth.acl" must be a boolean/);
  });

  it('rejects a non-string jwtExpiresIn', () => {
    expect(() => new NexxusApplication(withAuth({ jwtExpiresIn: 999 }))).toThrow(/jwtExpiresIn/);
  });

  it('rejects a non-object auth block', () => {
    expect(() => new NexxusApplication(makeData({ auth: 'nope' }))).toThrow(/"auth" must be an object/);
  });

  it('rejects a non-object userTypes', () => {
    expect(() => new NexxusApplication(withAuth({ userTypes: 'nope' }))).toThrow(/userTypes/);
  });

  it('hasAuthEnabled + getUserTypes reflect the presence of auth', () => {
    expect(new NexxusApplication(withAuth()).hasAuthEnabled()).toBe(true);
    expect(new NexxusApplication(makeData()).hasAuthEnabled()).toBe(false);
    expect(new NexxusApplication(makeData()).getUserTypes()).toBeNull();
  });
});

describe('NexxusApplication accessors', () => {
  it('getAppModelSchema injects a filterable userId when auth is enabled', () => {
    const app = new NexxusApplication(withAuth());

    expect(app.getAppModelSchema('runs').userId).toEqual({ type: 'string', required: true, filterable: true });
  });

  it('getAppModelSchema does not inject userId without auth', () => {
    expect(new NexxusApplication(makeData()).getAppModelSchema('runs').userId).toBeUndefined();
  });

  it('getAppModelSchema throws for an unknown model', () => {
    expect(() => new NexxusApplication(makeData()).getAppModelSchema('ghost')).toThrow(/Unknown app model type/);
  });

  it('static getModelSchema returns the application model schema', () => {
    expect(NexxusApplication.getModelSchema()).toHaveProperty('name');
  });

  it('getAclFields returns only fields flagged acl:true', () => {
    const app = new NexxusApplication(makeData({
      schema: { runs: { fields: { owner: { type: 'string', acl: true }, note: { type: 'string' } } } },
    }));

    expect(app.getAclFields('runs')).toEqual(new Set(['owner']));
  });

  it('getAclFields returns an empty set for an unknown model', () => {
    expect(new NexxusApplication(makeData()).getAclFields('ghost')).toEqual(new Set());
  });

  it('a non-subscribable model force-marks primitives and primitive-arrays filterable (not object-arrays)', () => {
    const app = new NexxusApplication(makeData({
      schema: {
        logs: {
          fields: {
            msg: { type: 'string' },
            levels: { type: 'array', arrayType: 'string' },
            entries: { type: 'array', arrayType: 'object', properties: {} },
          },
          subscribable: false,
        },
      },
    }));

    const filterable = app.getModelFilterableFields('logs');

    expect(filterable.has('msg')).toBe(true);
    expect(filterable.has('levels')).toBe(true);     // primitive-element array
    expect(filterable.has('entries')).toBe(false);   // array of objects
  });

  it('role manager map: set / get / getAll', () => {
    const app = new NexxusApplication(makeData());
    // Application only stores managers keyed by name — a minimal stand-in with
    // getRoleName is enough to test the map plumbing (the real NexxusAclManager
    // sits above Application in the dependency order).
    const managerA = { getRoleName: () => 'RoleA' } as never;

    app.setRoleManagers([managerA]);

    expect(app.getRoleManager('RoleA')).toBe(managerA);
    expect(app.getRoleManager('missing')).toBeUndefined();
    expect(app.getRoleManagers().size).toBe(1);
  });

  it('isSubscribable / isTransient throw for an unknown model', () => {
    const app = new NexxusApplication(makeData());

    expect(() => app.isSubscribable('ghost')).toThrow(/Unknown app model type/);
    expect(() => app.isTransient('ghost')).toThrow(/Unknown app model type/);
  });

  it('getAppModelFieldType returns a field type, or undefined when unknown', () => {
    const app = new NexxusApplication(makeData());

    expect(app.getAppModelFieldType('runs', 'note')).toBe('string');
    expect(app.getAppModelFieldType('runs', 'ghost')).toBeUndefined();
  });

  it('getUserDetailSchema returns the per-type schema, else null', () => {
    const withDetails = new NexxusApplication(withAuth({ userDetailSchema: { default: {}, driver: { license: { type: 'string' } } } }));

    expect(withDetails.getUserDetailSchema('driver')).toEqual({ license: { type: 'string' } });
    expect(withDetails.getUserDetailSchema('unknown')).toBeNull();
    // No auth → no user-detail schema at all.
    expect(new NexxusApplication(makeData()).getUserDetailSchema()).toBeNull();
  });

  it('getModelFilterableFields collects primitives, nested fields, and filterable arrays', () => {
    const app = new NexxusApplication(makeData({
      schema: {
        orders: {
          fields: {
            code: { type: 'string', filterable: true },
            meta: { type: 'object', properties: { region: { type: 'string', filterable: true }, note: { type: 'string' } } },
            tags: { type: 'array', arrayType: 'string', filterable: true },
            rawTags: { type: 'array', arrayType: 'string' },
          },
        },
      },
    }));

    const filterable = app.getModelFilterableFields('orders');

    expect(filterable.has('code')).toBe(true);
    expect(filterable.has('meta.region')).toBe(true);
    expect(filterable.has('meta.note')).toBe(false);
    expect(filterable.has('tags')).toBe(true);      // filterable array included
    expect(filterable.has('rawTags')).toBe(false);  // non-filterable array excluded
  });

  it('getModelFilterableFields returns an empty set for an unknown model', () => {
    expect(new NexxusApplication(makeData()).getModelFilterableFields('ghost').size).toBe(0);
  });

  it('a non-subscribable model force-marks nested object primitives filterable', () => {
    const app = new NexxusApplication(makeData({
      schema: {
        audit: { fields: { meta: { type: 'object', properties: { level: { type: 'string' } } } }, subscribable: false },
      },
    }));

    expect(app.getModelFilterableFields('audit').has('meta.level')).toBe(true);
  });
});
