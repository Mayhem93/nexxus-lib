import { describe, it, expect } from 'vitest';
import { NexxusAclConditionResolver, type NexxusAclContext } from '@mayhem93/nexxus-core-lib';

const CTX: NexxusAclContext = { userId: 'u1', userType: 'driver', appId: 'app1' };

describe('NexxusAclConditionResolver.resolve', () => {
  it('resolves a single-value equality to a bare field match', () => {
    const filter = NexxusAclConditionResolver.resolve({ StringEquals: { status: ['active'] } }, CTX);

    expect(filter).toEqual({ status: 'active' });
  });

  it('resolves a $nxx: reference from the context', () => {
    const filter = NexxusAclConditionResolver.resolve({ StringEquals: { userId: ['$nxx:userId'] } }, CTX);

    expect(filter).toEqual({ userId: 'u1' });
  });

  it('resolves multiple values of an equality to an `in`', () => {
    const filter = NexxusAclConditionResolver.resolve({ StringEquals: { role: ['$nxx:userType', 'admin'] } }, CTX);

    expect(filter).toEqual({ role: { in: ['driver', 'admin'] } });
  });

  it('resolves a single not-equals to `ne`', () => {
    const filter = NexxusAclConditionResolver.resolve({ StringNotEquals: { status: ['archived'] } }, CTX);

    expect(filter).toEqual({ status: { ne: 'archived' } });
  });

  it('resolves multiple not-equals to an AND of `ne` (must differ from all)', () => {
    const filter = NexxusAclConditionResolver.resolve({ StringNotEquals: { status: ['archived', 'deleted'] } }, CTX);

    expect(filter).toEqual({ $and: [{ status: { ne: 'archived' } }, { status: { ne: 'deleted' } }] });
  });

  it('passes numeric values through for numeric operators', () => {
    const filter = NexxusAclConditionResolver.resolve({ NumericEquals: { priority: [1] } }, CTX);

    expect(filter).toEqual({ priority: 1 });
  });

  it('ANDs multiple fields within a block', () => {
    const filter = NexxusAclConditionResolver.resolve(
      { StringEquals: { userId: ['$nxx:userId'], status: ['active'] } },
      CTX,
    );

    expect(filter).toEqual({ $and: [{ userId: 'u1' }, { status: 'active' }] });
  });

  it('ANDs multiple operator blocks', () => {
    const filter = NexxusAclConditionResolver.resolve(
      { StringEquals: { region: ['EU'] }, NumericEquals: { priority: [2] } },
      CTX,
    );

    expect(filter).toEqual({ $and: [{ region: 'EU' }, { priority: 2 }] });
  });

  it('drops a missing context value but keeps a literal in the same OR set', () => {
    const filter = NexxusAclConditionResolver.resolve(
      { StringEquals: { owner: ['$nxx:userId', 'system'] } },
      {}, // no userId → the ref drops, "system" remains
    );

    expect(filter).toEqual({ owner: 'system' });
  });

  it('returns null when a field has no resolvable value (unsatisfiable)', () => {
    const filter = NexxusAclConditionResolver.resolve({ StringEquals: { userId: ['$nxx:userId'] } }, {});

    expect(filter).toBeNull();
  });

  it('returns null for an empty condition', () => {
    expect(NexxusAclConditionResolver.resolve({}, CTX)).toBeNull();
  });

  it('skips an operator whose block is undefined', () => {
    expect(NexxusAclConditionResolver.resolve({ StringEquals: undefined } as never, CTX)).toBeNull();
  });
});
