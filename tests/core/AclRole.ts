import { describe, it, expect } from 'vitest';
import {
  NexxusAclRole,
  NexxusApplication,
  type INexxusApplication,
  type INexxusAclRole,
} from '@mayhem93/nexxus-core-lib';

const makeRole = (overrides: Record<string, unknown> = {}): INexxusAclRole => ({
  id: 'DriverRole',
  type: 'acl',
  appId: 'app1',
  statements: JSON.stringify([{ effect: 'Allow', action: ['read'], resource: ['runs'] }]),
  ...overrides,
} as INexxusAclRole);

describe('NexxusAclRole', () => {
  it('constructs a valid role, forcing type=acl', () => {
    const role = new NexxusAclRole(makeRole());

    expect(role.getName()).toBe('DriverRole');
    expect(role.getData().type).toBe('acl');
  });

  it('parses statements to objects while keeping the stored string form', () => {
    const role = new NexxusAclRole(makeRole());

    expect(role.getStatements()).toEqual([{ effect: 'Allow', action: ['read'], resource: ['runs'] }]);
    expect(typeof role.getData().statements).toBe('string');
  });

  it('requires a non-empty id (role name)', () => {
    expect(() => new NexxusAclRole(makeRole({ id: '' }))).toThrow(/"id" \(role name\) is required/);
  });

  it('requires statements to be a string', () => {
    expect(() => new NexxusAclRole(makeRole({ statements: [] }))).toThrow(/"statements" must be a JSON string/);
  });

  it('rejects statements that are not valid JSON', () => {
    expect(() => new NexxusAclRole(makeRole({ statements: '{not valid' }))).toThrow(/must be a valid JSON string/);
  });

  it('runs structural validation in the constructor (delegates to the validator)', () => {
    const role = makeRole({ statements: JSON.stringify([{ effect: 'Nope', action: ['read'], resource: ['runs'] }]) });

    expect(() => new NexxusAclRole(role)).toThrow(/"effect" must be/);
  });

  it('getModelSchema returns the acl model schema', () => {
    const schema = NexxusAclRole.getModelSchema();

    expect(schema).toHaveProperty('statements');
    expect(schema).toHaveProperty('appId');
  });

  describe('validateAgainstSchema (delegates to the validator with the owning app)', () => {
    const app = new NexxusApplication({
      id: 'app1', type: 'application', name: 'app',
      schema: { runs: { fields: { note: { type: 'string' } } } },
    } as INexxusApplication);

    it('passes for a role whose resources exist', () => {
      const role = new NexxusAclRole(makeRole());

      expect(() => role.validateAgainstSchema(app)).not.toThrow();
    });

    it('throws for a role referencing a non-existent model', () => {
      const role = new NexxusAclRole(makeRole({
        statements: JSON.stringify([{ effect: 'Allow', action: ['read'], resource: ['ghost'] }]),
      }));

      expect(() => role.validateAgainstSchema(app)).toThrow(/resource model "ghost" does not exist/);
    });
  });
});
