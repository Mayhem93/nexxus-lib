import { describe, it, expect, beforeEach } from 'vitest';
import {
  NexxusAclManager,
  NexxusAclRole,
  NexxusAppModel,
  DEFAULT_ACL_ROLE_ID,
  type INexxusAclRole,
  type NexxusAclStatement,
  type NexxusApplication,
} from '@mayhem93/nexxus-core-lib';
import { NexxusModelFieldCache } from '@mayhem93/nexxus-redis';

import { NexxusApiAcl } from '../../src/api/src/lib/Acl';
import { AccessDeniedException } from '../../src/api/src/lib/Exceptions';
import type { NexxusApiRequest, NexxusApiUser } from '../../src/api/src/lib/Api';

import { installApiStatics, seedApp, makeApp, makeAuthApp, logger, dbState } from './harness';
import { installFakeRedis } from '../redis/helpers';

/** `userId` is a builtin condition field, so a role can key off ownership. */
const schema = {
  runs: {
    fields: {
      note:  { type: 'string', required: false, filterable: true },
      owner: { type: 'string', required: false, filterable: true, acl: true },
    },
  },
};

const USER = {
  id: 'u1', username: 'ann', userType: 'default',
  authProviders: [ 'local' ], details: {}, appId: 'app1',
} as NexxusApiUser;

const reqFor = (user?: NexxusApiUser): NexxusApiRequest =>
  ({ headers: { 'nxx-app-id': 'app1' }, user }) as unknown as NexxusApiRequest;

/** Build an ACL-enabled app whose `default` user type resolves to `statements`. */
function aclApp(statements: NexxusAclStatement[], extraRoles: Record<string, NexxusAclStatement[]> = {}): NexxusApplication {
  const app = makeAuthApp({
    schema,
    auth: {
      strategies: { local: {} },
      userDetailSchema: { default: {} },
      acl: true,
      // `default` is force-injected by the Application constructor to point at
      // DEFAULT_ACL_ROLE_ID, so that's the role name the default user type reads.
      userTypes: Object.fromEntries(Object.keys(extraRoles).map(name => [ name, { roles: [ name ] } ])),
    },
  });

  const role = (id: string, sts: NexxusAclStatement[]): NexxusAclManager =>
    new NexxusAclManager(new NexxusAclRole({
      id,
      type: 'acl',
      appId: 'app1',
      statements: JSON.stringify(sts),
    } as INexxusAclRole));

  app.setRoleManagers([
    role(DEFAULT_ACL_ROLE_ID, statements),
    ...Object.entries(extraRoles).map(([ name, sts ]) => role(name, sts)),
  ]);

  return seedApp(app);
}

const ALLOW_ALL: NexxusAclStatement[] = [ { effect: 'Allow', action: [ '*' ], resource: [ '*' ] } ];
const ALLOW_OWN: NexxusAclStatement[] = [ {
  effect: 'Allow', action: [ '*' ], resource: [ 'runs' ],
  condition: { StringEquals: { userId: [ '$nxx:userId' ] } },
} ];

describe('NexxusApiAcl.authorize', () => {
  beforeEach(() => { installApiStatics(); });

  it('short-circuits to null when the application has ACLs disabled', () => {
    // The zero-overhead path: an app that doesn't use ACLs must not pay for
    // role resolution on every request.
    const app = seedApp(makeApp({ schema }));

    expect(NexxusApiAcl.authorize(app, reqFor(USER), 'search', 'runs')).toBeNull();
  });

  it('returns null for an unconditional grant', () => {
    // null means "allowed, nothing to narrow by" — not "denied".
    expect(NexxusApiAcl.authorize(aclApp(ALLOW_ALL), reqFor(USER), 'search', 'runs')).toBeNull();
  });

  it('returns the row constraint for a conditional grant', () => {
    const constraint = NexxusApiAcl.authorize(aclApp(ALLOW_OWN), reqFor(USER), 'search', 'runs');

    // `$nxx:userId` is resolved against the request principal, so the constraint
    // handed back names THIS user rather than the placeholder.
    expect(constraint).toEqual({ userId: 'u1' });
  });

  it('denies an action no role grants', () => {
    const app = aclApp([ { effect: 'Allow', action: [ 'read' ], resource: [ 'runs' ] } ]);

    expect(() => NexxusApiAcl.authorize(app, reqFor(USER), 'create', 'runs')).toThrow(AccessDeniedException);
  });

  it('denies an action on a model no role names', () => {
    const app = aclApp([ { effect: 'Allow', action: [ '*' ], resource: [ 'other' ] } ]);

    expect(() => NexxusApiAcl.authorize(app, reqFor(USER), 'search', 'runs')).toThrow(AccessDeniedException);
  });

  it('logs the denial with the principal, action, model and reason', () => {
    const app = aclApp([ { effect: 'Allow', action: [ 'read' ], resource: [ 'runs' ] } ]);

    expect(() => NexxusApiAcl.authorize(app, reqFor(USER), 'create', 'runs')).toThrow();

    // A 403 body says nothing (deliberately), so the log is the only place the
    // reason exists — without it a denial is undebuggable.
    expect(logger.has('info', /ACL deny: create "runs"/)).toBe(true);
    expect(logger.has('info', /user "u1"/)).toBe(true);
    expect(logger.has('info', /no granted role allows this action/)).toBe(true);
  });

  it('reports an unauthenticated caller as anonymous rather than crashing', () => {
    const app = aclApp([ { effect: 'Allow', action: [ 'read' ], resource: [ 'runs' ] } ]);

    expect(() => NexxusApiAcl.authorize(app, reqFor(), 'create', 'runs')).toThrow(AccessDeniedException);
    expect(logger.has('info', /user "anonymous"/)).toBe(true);
  });

  it('falls back to the "default" user type for a request with no principal', () => {
    // A zero-auth app with ACLs on still resolves roles — via `default`.
    expect(NexxusApiAcl.authorize(aclApp(ALLOW_ALL), reqFor(), 'search', 'runs')).toBeNull();
  });

  it('resolves the roles of the principal\'s OWN user type', () => {
    const app = aclApp(ALLOW_ALL, { admin: [ { effect: 'Allow', action: [ 'read' ], resource: [ 'runs' ] } ] });
    const admin = { ...USER, userType: 'admin' } as NexxusApiUser;

    expect(NexxusApiAcl.authorize(app, reqFor(admin), 'get', 'runs')).toBeNull();
    // The admin role grants reads only — the default role's blanket allow must
    // not leak across user types.
    expect(() => NexxusApiAcl.authorize(app, reqFor(admin), 'create', 'runs')).toThrow(AccessDeniedException);
  });

  it('lets an explicit Deny beat an Allow', () => {
    const app = aclApp([
      { effect: 'Allow', action: [ '*' ], resource: [ '*' ] },
      { effect: 'Deny', action: [ 'delete' ], resource: [ 'runs' ] },
    ]);

    expect(NexxusApiAcl.authorize(app, reqFor(USER), 'get', 'runs')).toBeNull();
    expect(() => NexxusApiAcl.authorize(app, reqFor(USER), 'delete', 'runs')).toThrow(AccessDeniedException);
  });
});

describe('NexxusApiAcl.enforceRowConstraint', () => {
  beforeEach(() => { installApiStatics(); });

  it('is a no-op for an unrestricted grant, even with no object', () => {
    const app = aclApp(ALLOW_ALL);

    expect(() => NexxusApiAcl.enforceRowConstraint(app, reqFor(USER), 'get', 'runs', null, null)).not.toThrow();
  });

  it('allows an object that satisfies the constraint', () => {
    const app = aclApp(ALLOW_OWN);

    expect(() => NexxusApiAcl.enforceRowConstraint(
      app, reqFor(USER), 'get', 'runs', { userId: 'u1' }, { userId: 'u1', note: 'hi' },
    )).not.toThrow();
  });

  it('denies an object that does not satisfy the constraint', () => {
    const app = aclApp(ALLOW_OWN);

    expect(() => NexxusApiAcl.enforceRowConstraint(
      app, reqFor(USER), 'get', 'runs', { userId: 'u1' }, { userId: 'someone-else' },
    )).toThrow(AccessDeniedException);

    expect(logger.has('info', /object does not satisfy the row condition/)).toBe(true);
  });

  it('denies a missing object, and says so in the log but not the response', () => {
    // A 403 rather than a 404: telling a caller that an object it may not read
    // does not exist is still telling it something about that object.
    const app = aclApp(ALLOW_OWN);
    let thrown: unknown;

    try {
      NexxusApiAcl.enforceRowConstraint(app, reqFor(USER), 'get', 'runs', { userId: 'u1' }, null);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AccessDeniedException);
    expect((thrown as AccessDeniedException).message).toBe('Access denied');
    expect(logger.has('info', /target object not found/)).toBe(true);
  });
});

describe('NexxusApiAcl.loadObjectAttributes', () => {
  beforeEach(() => {
    installApiStatics();
    // After installApiStatics — the NexxusRedis constructor claims the static
    // instance, and the field cache reads through it.
    installFakeRedis();
  });

  it('reads from the field cache when it is populated', async () => {
    await new NexxusModelFieldCache('m1', { userId: 'u1', owner: 'ann' }).save();

    expect(await NexxusApiAcl.loadObjectAttributes('app1', 'runs', 'm1')).toEqual({ userId: 'u1', owner: 'ann' });
    // The cache exists so a write doesn't need a full read path — going to the
    // database anyway would make it pointless.
    expect(dbState.getItemsCalls).toHaveLength(0);
  });

  it('falls back to the database on a cache miss', async () => {
    dbState.getItemsResult = [ new NexxusAppModel(
      { id: 'm1', type: 'runs', appId: 'app1', userId: 'u1', note: 'hi' },
      schema as never,
    ) ];

    expect(await NexxusApiAcl.loadObjectAttributes('app1', 'runs', 'm1')).toMatchObject({ id: 'm1', userId: 'u1' });
    expect(dbState.getItemsCalls[0]).toMatchObject({ ids: [ 'm1' ], type: 'runs', appId: 'app1' });
  });

  it('returns null when the object is in neither', async () => {
    expect(await NexxusApiAcl.loadObjectAttributes('app1', 'runs', 'ghost')).toBeNull();
  });
});

describe('NexxusApiAcl.subscriptionFilter', () => {
  beforeEach(() => { installApiStatics(); });

  it('is the constraint alone when the client supplied no filter', () => {
    const app = aclApp(ALLOW_OWN);
    const filter = NexxusApiAcl.subscriptionFilter(app, 'runs', undefined, { userId: 'u1' });

    expect(filter.test({ userId: 'u1' })).toBe(true);
    expect(filter.test({ userId: 'u2' })).toBe(false);
  });

  it('ANDs the client filter with the constraint', () => {
    const app = aclApp(ALLOW_OWN);
    const filter = NexxusApiAcl.subscriptionFilter(app, 'runs', { note: 'hi' }, { userId: 'u1' });

    expect(filter.test({ note: 'hi', userId: 'u1' })).toBe(true);
    expect(filter.test({ note: 'hi', userId: 'u2' })).toBe(false);
    expect(filter.test({ note: 'bye', userId: 'u1' })).toBe(false);
  });

  it('cannot be widened by the client filter', () => {
    // Folding the constraint in here is what keeps the transport manager
    // ACL-agnostic: it just matches this filter, and must never be handed one
    // that would fan a row out to someone not allowed to read it.
    const app = aclApp(ALLOW_OWN);
    const filter = NexxusApiAcl.subscriptionFilter(
      app, 'runs', { $or: [ { userId: 'u1' }, { userId: 'u2' } ] }, { userId: 'u1' },
    );

    expect(filter.test({ userId: 'u1' })).toBe(true);
    expect(filter.test({ userId: 'u2' })).toBe(false);
  });

  it('derives the same filter from the same inputs', () => {
    // Subscribe and unsubscribe both call this, and the resulting filter is
    // what the channel key is derived from — two different answers would leave
    // a subscription that can never be removed.
    const app = aclApp(ALLOW_OWN);
    const args = [ app, 'runs', { note: 'hi' }, { userId: 'u1' } ] as const;

    expect(NexxusApiAcl.subscriptionFilter(...args).getNormalizedQuery())
      .toEqual(NexxusApiAcl.subscriptionFilter(...args).getNormalizedQuery());
  });
});
