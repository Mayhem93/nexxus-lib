import { describe, it, expect } from 'vitest';
import {
  NexxusAclManager,
  NexxusAclRole,
  NexxusApplication,
  type INexxusApplication,
  type NexxusAclStatement,
  type NexxusUserTypeConfig,
} from '@mayhem93/nexxus-core-lib';

const OWN = { StringEquals: { userId: ['$nxx:userId'] } };
const ACTIVE = { StringEquals: { status: ['active'] } };

const makeManager = (id: string, statements: NexxusAclStatement[]): NexxusAclManager =>
  new NexxusAclManager(new NexxusAclRole({ id, type: 'acl', appId: 'app1', statements: JSON.stringify(statements) }));

const makeApp = (userTypes: Record<string, NexxusUserTypeConfig>, managers: NexxusAclManager[]): NexxusApplication => {
  const app = new NexxusApplication({
    id: 'app1', type: 'application', name: 'app',
    schema: { runs: { fields: { note: { type: 'string' } } } },
    auth: { jwtSecret: 's', strategies: { local: {} }, userDetailSchema: { default: {} }, userTypes },
  } as INexxusApplication);

  app.setRoleManagers(managers);

  return app;
};

describe('NexxusAclManager.evaluate (single role)', () => {
  it('unconditional allow → allow with no constraint', () => {
    const manager = makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'] }]);

    expect(manager.evaluate('get', 'runs', {})).toEqual({ decision: 'allow', constraint: null });
  });

  it('a matching Deny wins outright', () => {
    const manager = makeManager('R', [
      { effect: 'Allow', action: ['read'], resource: ['runs'] },
      { effect: 'Deny', action: ['read'], resource: ['runs'] },
    ]);

    expect(manager.evaluate('get', 'runs', {})).toEqual({ decision: 'deny' });
  });

  it('neutral when the action does not match', () => {
    const manager = makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'] }]);

    expect(manager.evaluate('create', 'runs', {})).toEqual({ decision: 'neutral' });
  });

  it('neutral when the model does not match', () => {
    const manager = makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'] }]);

    expect(manager.evaluate('get', 'cargo', {})).toEqual({ decision: 'neutral' });
  });

  it('conditional allow → allow with the resolved row constraint', () => {
    const manager = makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'], condition: OWN }]);

    expect(manager.evaluate('get', 'runs', { userId: 'u1' })).toEqual({ decision: 'allow', constraint: { userId: 'u1' } });
  });

  it('conditional allow whose condition is unsatisfiable → neutral', () => {
    const manager = makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'], condition: OWN }]);

    expect(manager.evaluate('get', 'runs', {})).toEqual({ decision: 'neutral' });
  });

  it('an unconditional allow beats a conditional one (no row restriction)', () => {
    const manager = makeManager('R', [
      { effect: 'Allow', action: ['read'], resource: ['runs'] },
      { effect: 'Allow', action: ['read'], resource: ['runs'], condition: OWN },
    ]);

    expect(manager.evaluate('get', 'runs', { userId: 'u1' })).toEqual({ decision: 'allow', constraint: null });
  });

  it('multiple conditional allows OR their constraints', () => {
    const manager = makeManager('R', [
      { effect: 'Allow', action: ['read'], resource: ['runs'], condition: OWN },
      { effect: 'Allow', action: ['read'], resource: ['runs'], condition: ACTIVE },
    ]);

    expect(manager.evaluate('get', 'runs', { userId: 'u1' })).toEqual({
      decision: 'allow',
      constraint: { $or: [{ userId: 'u1' }, { status: 'active' }] },
    });
  });

  it('wildcard action + resource allows anything', () => {
    const manager = makeManager('R', [{ effect: 'Allow', action: ['*'], resource: ['*'] }]);

    expect(manager.evaluate('delete', 'anything', {})).toEqual({ decision: 'allow', constraint: null });
  });

  it('exposes the bound role', () => {
    const manager = makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'] }]);

    expect(manager.getRoleName()).toBe('R');
    expect(manager.getRole().getName()).toBe('R');
  });
});

describe('NexxusAclManager.resolve (across a user type\'s roles)', () => {
  it('allows via an unconditional role → no constraint', () => {
    const app = makeApp({ driver: { roles: ['R'] } }, [makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'] }])]);

    expect(NexxusAclManager.resolve(app, 'driver', 'get', 'runs', {})).toEqual({ allowed: true, constraint: null });
  });

  it('default-denies when no role grants the action', () => {
    const app = makeApp({ driver: { roles: ['R'] } }, [makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'] }])]);

    expect(NexxusAclManager.resolve(app, 'driver', 'create', 'runs', {})).toEqual({ allowed: false });
  });

  it('an explicit deny in any role wins over an allow', () => {
    const app = makeApp({ driver: { roles: ['A', 'B'] } }, [
      makeManager('A', [{ effect: 'Allow', action: ['read'], resource: ['runs'] }]),
      makeManager('B', [{ effect: 'Deny', action: ['read'], resource: ['runs'] }]),
    ]);

    expect(NexxusAclManager.resolve(app, 'driver', 'get', 'runs', {})).toEqual({ allowed: false });
  });

  it('surfaces a conditional grant as a row constraint', () => {
    const app = makeApp({ driver: { roles: ['R'] } }, [makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'], condition: OWN }])]);

    expect(NexxusAclManager.resolve(app, 'driver', 'get', 'runs', { userId: 'u1' }))
      .toEqual({ allowed: true, constraint: { userId: 'u1' } });
  });

  it('ORs conditional constraints across multiple roles', () => {
    const app = makeApp({ driver: { roles: ['A', 'B'] } }, [
      makeManager('A', [{ effect: 'Allow', action: ['read'], resource: ['runs'], condition: OWN }]),
      makeManager('B', [{ effect: 'Allow', action: ['read'], resource: ['runs'], condition: ACTIVE }]),
    ]);

    expect(NexxusAclManager.resolve(app, 'driver', 'get', 'runs', { userId: 'u1' }))
      .toEqual({ allowed: true, constraint: { $or: [{ userId: 'u1' }, { status: 'active' }] } });
  });

  it('denies for an unknown user type (no roles)', () => {
    const app = makeApp({ driver: { roles: ['R'] } }, [makeManager('R', [{ effect: 'Allow', action: ['read'], resource: ['runs'] }])]);

    expect(NexxusAclManager.resolve(app, 'ghost', 'get', 'runs', {})).toEqual({ allowed: false });
  });

  it('skips a role name that has no loaded manager', () => {
    const app = makeApp({ driver: { roles: ['Missing'] } }, []);

    expect(NexxusAclManager.resolve(app, 'driver', 'get', 'runs', {})).toEqual({ allowed: false });
  });
});
