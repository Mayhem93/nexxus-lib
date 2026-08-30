import { describe, it, expect } from 'vitest';
import {
  NexxusAclStatementValidator,
  NexxusApplication,
  type INexxusApplication,
  type NexxusAclStatement,
} from '@mayhem93/nexxus-core-lib';

const ROLE = 'TestRole';

describe('NexxusAclStatementValidator.validateStructure', () => {
  it('accepts a well-formed statement', () => {
    const statements = [{ effect: 'Allow', action: ['read'], resource: ['runs'] }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).not.toThrow();
  });

  it('accepts a valid condition on an Allow', () => {
    const statements = [{
      effect: 'Allow', action: ['read'], resource: ['runs'],
      condition: { StringEquals: { userId: ['$nxx:userId'] } },
    }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).not.toThrow();
  });

  it('rejects non-array statements', () => {
    expect(() => NexxusAclStatementValidator.validateStructure({}, ROLE)).toThrow(/must be an array/);
  });

  it('rejects a non-object statement', () => {
    expect(() => NexxusAclStatementValidator.validateStructure(['nope'], ROLE)).toThrow(/must be an object/);
  });

  it('rejects an invalid effect', () => {
    const statements = [{ effect: 'Maybe', action: ['read'], resource: ['runs'] }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/"effect" must be/);
  });

  it('rejects an empty action array', () => {
    const statements = [{ effect: 'Allow', action: [], resource: ['runs'] }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/"action" must be a non-empty array/);
  });

  it('rejects an unknown action token', () => {
    const statements = [{ effect: 'Allow', action: ['destroy'], resource: ['runs'] }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/unknown action "destroy"/);
  });

  it('rejects an empty resource array', () => {
    const statements = [{ effect: 'Allow', action: ['read'], resource: [] }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/"resource" must be a non-empty array/);
  });

  it('rejects an empty-string resource entry', () => {
    const statements = [{ effect: 'Allow', action: ['read'], resource: [''] }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/"resource" entries must be non-empty strings/);
  });

  it('rejects a field-level (colon) resource', () => {
    const statements = [{ effect: 'Allow', action: ['read'], resource: ['runs:status'] }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/field-level resource/);
  });

  it('rejects a non-object condition', () => {
    const statements = [{ effect: 'Allow', action: ['read'], resource: ['runs'], condition: 'nope' }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/"condition" must be an object/);
  });

  it('rejects a non-object operator block', () => {
    const statements = [{ effect: 'Allow', action: ['read'], resource: ['runs'], condition: { StringEquals: 'nope' } }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/condition "StringEquals" must be an object/);
  });

  it('rejects an unknown condition operator', () => {
    const statements = [{ effect: 'Allow', action: ['read'], resource: ['runs'], condition: { Contains: { x: ['y'] } } }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/unknown condition operator "Contains"/);
  });

  it('rejects an unknown context key', () => {
    const statements = [{
      effect: 'Allow', action: ['read'], resource: ['runs'],
      condition: { StringEquals: { userId: ['$nxx:tenant'] } },
    }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/unknown context key "\$nxx:tenant"/);
  });

  it('rejects a non-scalar condition value', () => {
    const statements = [{
      effect: 'Allow', action: ['read'], resource: ['runs'],
      condition: { StringEquals: { userId: [{}] } },
    }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/values must be strings or numbers/);
  });

  it('rejects an empty condition value array', () => {
    const statements = [{
      effect: 'Allow', action: ['read'], resource: ['runs'],
      condition: { StringEquals: { userId: [] } },
    }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).toThrow(/must be a non-empty array/);
  });

  it('ignores a condition on a Deny (unconditional in v1)', () => {
    // A Deny's condition is deliberately NOT structurally validated — documents
    // the v1 rule that Deny is a plain model+action block.
    const statements = [{ effect: 'Deny', action: ['read'], resource: ['runs'], condition: { Bogus: 'nope' } }];

    expect(() => NexxusAclStatementValidator.validateStructure(statements, ROLE)).not.toThrow();
  });
});

describe('NexxusAclStatementValidator.validateAgainstSchema', () => {
  const makeApp = (schema: INexxusApplication['schema']): NexxusApplication =>
    new NexxusApplication({ id: 'app-test', type: 'application', name: 'test app', schema } as INexxusApplication);

  const app = makeApp({
    runs: {
      fields: {
        owner:    { type: 'string', required: false, acl: true,  filterable: true },
        noAcl:    { type: 'string', required: false, acl: false, filterable: true },
        noFilter: { type: 'string', required: false, acl: true },
      },
    },
    routes: { fields: { from: { type: 'string', required: true } } },
  });

  it('accepts a builtin (userId) ownership condition', () => {
    const statements: NexxusAclStatement[] = [{
      effect: 'Allow', action: ['read'], resource: ['runs'],
      condition: { StringEquals: { userId: ['$nxx:userId'] } },
    }];

    expect(() => NexxusAclStatementValidator.validateAgainstSchema(statements, app, ROLE)).not.toThrow();
  });

  it('accepts an acl:true + filterable condition field', () => {
    const statements: NexxusAclStatement[] = [{
      effect: 'Allow', action: ['read'], resource: ['runs'],
      condition: { StringEquals: { owner: ['$nxx:userId'] } },
    }];

    expect(() => NexxusAclStatementValidator.validateAgainstSchema(statements, app, ROLE)).not.toThrow();
  });

  it('accepts resources with no condition', () => {
    const statements: NexxusAclStatement[] = [{ effect: 'Allow', action: ['read'], resource: ['runs', 'routes'] }];

    expect(() => NexxusAclStatementValidator.validateAgainstSchema(statements, app, ROLE)).not.toThrow();
  });

  it('rejects a resource model not in the schema', () => {
    const statements: NexxusAclStatement[] = [{ effect: 'Allow', action: ['read'], resource: ['ghost'] }];

    expect(() => NexxusAclStatementValidator.validateAgainstSchema(statements, app, ROLE))
      .toThrow(/resource model "ghost" does not exist/);
  });

  it('rejects a condition field not declared acl:true', () => {
    const statements: NexxusAclStatement[] = [{
      effect: 'Allow', action: ['read'], resource: ['runs'],
      condition: { StringEquals: { noAcl: ['$nxx:userId'] } },
    }];

    expect(() => NexxusAclStatementValidator.validateAgainstSchema(statements, app, ROLE))
      .toThrow(/must be declared "acl: true"/);
  });

  it('rejects an acl field that is not filterable', () => {
    const statements: NexxusAclStatement[] = [{
      effect: 'Allow', action: ['read'], resource: ['runs'],
      condition: { StringEquals: { noFilter: ['$nxx:userId'] } },
    }];

    expect(() => NexxusAclStatementValidator.validateAgainstSchema(statements, app, ROLE))
      .toThrow(/must be a filterable primitive/);
  });

  it('rejects a condition field that does not exist on the model', () => {
    const statements: NexxusAclStatement[] = [{
      effect: 'Allow', action: ['read'], resource: ['runs'],
      condition: { StringEquals: { nope: ['$nxx:userId'] } },
    }];

    expect(() => NexxusAclStatementValidator.validateAgainstSchema(statements, app, ROLE))
      .toThrow(/does not exist on model "runs"/);
  });

  it('rejects a non-builtin condition field with a wildcard resource', () => {
    const statements: NexxusAclStatement[] = [{
      effect: 'Allow', action: ['read'], resource: ['*'],
      condition: { StringEquals: { owner: ['$nxx:userId'] } },
    }];

    expect(() => NexxusAclStatementValidator.validateAgainstSchema(statements, app, ROLE)).toThrow(/wildcard/);
  });

  it('accepts a builtin condition field with a wildcard resource', () => {
    const statements: NexxusAclStatement[] = [{
      effect: 'Allow', action: ['read'], resource: ['*'],
      condition: { StringEquals: { userId: ['$nxx:userId'] } },
    }];

    expect(() => NexxusAclStatementValidator.validateAgainstSchema(statements, app, ROLE)).not.toThrow();
  });
});
