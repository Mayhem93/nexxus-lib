import { describe, it, expect } from 'vitest';
import { NexxusFilterQuery, InvalidQueryFilterException, type NexxusModelDef } from '@mayhem93/nexxus-core-lib';

const SCHEMA: NexxusModelDef = {
  title:  { type: 'string',  filterable: true },
  count:  { type: 'int',     filterable: true },
  ratio:  { type: 'float',   filterable: true },
  active: { type: 'boolean', filterable: true },
  due:    { type: 'date',    filterable: true },
  secret: { type: 'string' }, // not filterable
  tags:     { type: 'array', arrayType: 'string',  filterable: true },
  intTags:  { type: 'array', arrayType: 'int',     filterable: true },
  floatTags:{ type: 'array', arrayType: 'float',   filterable: true },
  boolTags: { type: 'array', arrayType: 'boolean', filterable: true },
  dateTags: { type: 'array', arrayType: 'date',    filterable: true },
  objTags:  { type: 'array', arrayType: 'object',  filterable: true, properties: {} },
  rawTags:  { type: 'array', arrayType: 'string' }, // array, but not filterable
  meta:   { type: 'object', properties: { code: { type: 'string', filterable: true }, note: { type: 'string' } } },
} as NexxusModelDef;

const build = (query: unknown): NexxusFilterQuery => new NexxusFilterQuery(query as never, SCHEMA);

describe('NexxusFilterQuery construction / validation', () => {
  it('rejects an unknown field', () => {
    expect(() => build({ ghost: 'x' })).toThrow(/does not exist in model schema/);
  });

  it('throws an InvalidQueryFilterException (not a generic Error)', () => {
    expect(() => build({ ghost: 'x' })).toThrow(InvalidQueryFilterException);
  });

  it('rejects filtering directly on an object field (use dot notation instead)', () => {
    expect(() => build({ meta: 'x' })).toThrow(/object field/);
  });

  it('rejects a non-filterable field', () => {
    expect(() => build({ secret: 'x' })).toThrow(/is not filterable/);
  });

  it('rejects an empty operator object', () => {
    expect(() => build({ count: {} })).toThrow(/empty operator object/);
  });

  it('rejects more than one operator per condition', () => {
    expect(() => build({ count: { gt: 1, lt: 5 } })).toThrow(/one operator per condition/);
  });

  it('rejects comparison operators on non-numeric/date fields', () => {
    expect(() => build({ title: { gt: 'a' } })).toThrow(/can only be used with int, float or date/);
  });

  it('rejects "in" with a non-array value', () => {
    expect(() => build({ count: { in: 5 } })).toThrow(/must have an array value/);
  });

  it('validates each element of an "in" array', () => {
    expect(() => build({ count: { in: [1, 'x'] } })).toThrow(/must be an integer/);
  });

  describe('value type validation', () => {
    it('string field rejects non-string', () => {
      expect(() => build({ title: 123 })).toThrow(/must be a string/);
    });

    it('int field rejects a float and a string', () => {
      expect(() => build({ count: 1.5 })).toThrow(/must be an integer/);
      expect(() => build({ count: 'x' })).toThrow(/must be an integer/);
    });

    it('float field accepts a finite number, rejects a non-number and a non-finite number', () => {
      expect(() => build({ ratio: 1.5 })).not.toThrow();
      expect(() => build({ ratio: 'x' })).toThrow(/must be a float/);
      expect(() => build({ ratio: Infinity })).toThrow(/must be a float/);
    });

    it('boolean field rejects a non-boolean', () => {
      expect(() => build({ active: 'x' })).toThrow(/must be a boolean/);
    });

    it('date field accepts a unix timestamp or ISO string, rejects garbage', () => {
      expect(() => build({ due: 1700000000 })).not.toThrow();
      expect(() => build({ due: '2024-01-01' })).not.toThrow();
      expect(() => build({ due: 'notadate' })).toThrow(/Unix timestamp or ISO date/);
    });
  });

  describe('logical operators', () => {
    it('rejects an empty logical array', () => {
      expect(() => build({ $and: [] })).toThrow(/at least one condition/);
    });

    it('rejects a non-array logical value', () => {
      expect(() => build({ $or: 'x' })).toThrow(/at least one condition/);
    });

    it('accepts nested logical operators', () => {
      expect(() => build({ $and: [{ title: 'a' }, { $or: [{ count: 1 }, { count: 2 }] }] })).not.toThrow();
    });
  });

  describe('dot-notation paths into object fields', () => {
    it('accepts a nested filterable field', () => {
      expect(() => build({ 'meta.code': 'x' })).not.toThrow();
    });

    it('rejects a nested non-filterable field', () => {
      expect(() => build({ 'meta.note': 'x' })).toThrow(/is not filterable/);
    });

    it('rejects an unknown nested field', () => {
      expect(() => build({ 'meta.ghost': 'x' })).toThrow(/does not exist/);
    });

    it('rejects traversing into a non-object field', () => {
      expect(() => build({ 'title.foo': 'x' })).toThrow(/does not exist/);
    });
  });
});

describe('NexxusFilterQuery.getNodes (parsed shape)', () => {
  it('parses a simple equality into an eq field node', () => {
    expect(build({ title: 'hello' }).getNodes()).toEqual([
      { type: 'field', field: 'title', operator: 'eq', value: 'hello' },
    ]);
  });

  it('parses an operator condition', () => {
    expect(build({ count: { gte: 3 } }).getNodes()).toEqual([
      { type: 'field', field: 'count', operator: 'gte', value: 3 },
    ]);
  });

  it('parses "in" keeping the array value', () => {
    expect(build({ count: { in: [1, 2, 3] } }).getNodes()).toEqual([
      { type: 'field', field: 'count', operator: 'in', value: [1, 2, 3] },
    ]);
  });

  it('parses a logical node with child conditions', () => {
    expect(build({ $or: [{ title: 'a' }, { count: 1 }] }).getNodes()).toEqual([
      {
        type: 'logical',
        operator: '$or',
        conditions: [
          { type: 'field', field: 'title', operator: 'eq', value: 'a' },
          { type: 'field', field: 'count', operator: 'eq', value: 1 },
        ],
      },
    ]);
  });
});

describe('NexxusFilterQuery.test (object matching)', () => {
  it('equality matches / mismatches / missing field', () => {
    const q = build({ title: 'hello' });

    expect(q.test({ title: 'hello' } as never)).toBe(true);
    expect(q.test({ title: 'bye' } as never)).toBe(false);
    expect(q.test({} as never)).toBe(false);
  });

  it('ne', () => {
    const q = build({ title: { ne: 'x' } });

    expect(q.test({ title: 'y' } as never)).toBe(true);
    expect(q.test({ title: 'x' } as never)).toBe(false);
  });

  it('numeric comparisons, and false on a non-numeric actual value', () => {
    expect(build({ count: { gt: 5 } }).test({ count: 10 } as never)).toBe(true);
    expect(build({ count: { gt: 5 } }).test({ count: 3 } as never)).toBe(false);
    expect(build({ count: { gte: 5 } }).test({ count: 5 } as never)).toBe(true);
    expect(build({ count: { lt: 5 } }).test({ count: 4 } as never)).toBe(true);
    expect(build({ count: { lte: 5 } }).test({ count: 5 } as never)).toBe(true);
    expect(build({ count: { gt: 5 } }).test({ count: 'nope' } as never)).toBe(false);
  });

  it('in (membership)', () => {
    const q = build({ count: { in: [1, 2, 3] } });

    expect(q.test({ count: 2 } as never)).toBe(true);
    expect(q.test({ count: 9 } as never)).toBe(false);
  });

  it('implicit AND across top-level fields', () => {
    const q = build({ title: 'a', count: 5 });

    expect(q.test({ title: 'a', count: 5 } as never)).toBe(true);
    expect(q.test({ title: 'a', count: 6 } as never)).toBe(false);
  });

  it('$and requires all, $or requires any', () => {
    const and = build({ $and: [{ title: 'a' }, { count: { gt: 1 } }] });

    expect(and.test({ title: 'a', count: 5 } as never)).toBe(true);
    expect(and.test({ title: 'a', count: 0 } as never)).toBe(false);

    const or = build({ $or: [{ title: 'a' }, { title: 'b' }] });

    expect(or.test({ title: 'b' } as never)).toBe(true);
    expect(or.test({ title: 'c' } as never)).toBe(false);
  });

  it('nested logical operators', () => {
    const q = build({ $and: [{ title: 'a' }, { $or: [{ count: 1 }, { count: 2 }] }] });

    expect(q.test({ title: 'a', count: 2 } as never)).toBe(true);
    expect(q.test({ title: 'a', count: 3 } as never)).toBe(false);
    expect(q.test({ title: 'z', count: 1 } as never)).toBe(false);
  });

  it('matches a nested field via dot notation', () => {
    const q = build({ 'meta.code': 'x' });

    expect(q.test({ meta: { code: 'x' } } as never)).toBe(true);
    expect(q.test({ meta: { code: 'y' } } as never)).toBe(false);
    expect(q.test({} as never)).toBe(false);
  });
});

describe('NexxusFilterQuery.getNormalizedQuery', () => {
  it('deep-sorts the query keys', () => {
    const normalized = build({ count: { gt: 1 }, active: true }).getNormalizedQuery();

    expect(Object.keys(normalized)).toEqual(['active', 'count']);
  });
});

describe('NexxusFilterQuery array-field filtering (membership)', () => {
  it('allows a filterable array field and validates the element type', () => {
    expect(() => build({ tags: 'urgent' })).not.toThrow();
    expect(() => build({ tags: 123 })).toThrow(/must be a string \(array contains strings\)/);
  });

  it('rejects a non-filterable array field', () => {
    expect(() => build({ rawTags: 'x' })).toThrow(/is not filterable/);
  });

  it('rejects comparison operators on an array field', () => {
    expect(() => build({ tags: { gt: 'x' } })).toThrow(/can only be used with int, float or date/);
  });

  it('validates "in" element types on an array field', () => {
    expect(() => build({ tags: { in: ['a', 'b'] } })).not.toThrow();
    expect(() => build({ tags: { in: [1] } })).toThrow(/must be a string/);
  });

  it('validates each array element type (int / float / boolean / date)', () => {
    expect(() => build({ intTags: 'x' })).toThrow(/must be an integer \(array contains integers\)/);
    expect(() => build({ floatTags: 'x' })).toThrow(/must be a float \(array contains floats\)/);
    expect(() => build({ boolTags: 'x' })).toThrow(/must be a boolean \(array contains booleans\)/);
    expect(() => build({ dateTags: 5 })).toThrow(/ISO date string \(array contains dates\)/);
    expect(() => build({ dateTags: '2024-01-01' })).not.toThrow();
  });

  it('accepts valid elements for each array element type', () => {
    expect(() => build({ intTags: 5 })).not.toThrow();
    expect(() => build({ floatTags: 1.5 })).not.toThrow();
    expect(() => build({ boolTags: true })).not.toThrow();
  });

  it('applies the same numeric edge checks to array elements', () => {
    expect(() => build({ intTags: 1.5 })).toThrow(/must be an integer \(array contains integers\)/);
    expect(() => build({ floatTags: Infinity })).toThrow(/must be a float \(array contains floats\)/);
    expect(() => build({ dateTags: 'notadate' })).toThrow(/ISO date string \(array contains dates\)/);
  });

  it('rejects filtering an array-of-objects field', () => {
    expect(() => build({ objTags: 'x' })).toThrow(/Cannot query array of objects/);
  });

  describe('test() membership', () => {
    it('eq = contains', () => {
      const q = build({ tags: 'urgent' });

      expect(q.test({ tags: ['a', 'urgent'] } as never)).toBe(true);
      expect(q.test({ tags: ['a'] } as never)).toBe(false);
    });

    it('ne = does not contain', () => {
      const q = build({ tags: { ne: 'urgent' } });

      expect(q.test({ tags: ['a'] } as never)).toBe(true);
      expect(q.test({ tags: ['a', 'urgent'] } as never)).toBe(false);
    });

    it('in = contains any', () => {
      const q = build({ tags: { in: ['x', 'urgent'] } });

      expect(q.test({ tags: ['a', 'urgent'] } as never)).toBe(true);
      expect(q.test({ tags: ['a'] } as never)).toBe(false);
    });
  });
});

describe('NexxusFilterQuery iterator', () => {
  it('yields nodes with depth and parent operator', () => {
    const q = build({ $and: [{ title: 'a' }, { $or: [{ count: 1 }] }] });

    const seen = [...q].map(node => ({
      type: node.type,
      operator: node.type === 'logical' ? node.operator : (node as { operator: string }).operator,
      depth: node.depth,
      parent: node.parentOperator,
    }));

    expect(seen).toEqual([
      { type: 'logical', operator: '$and', depth: 0, parent: undefined },
      { type: 'field', operator: 'eq', depth: 1, parent: '$and' },
      { type: 'logical', operator: '$or', depth: 1, parent: '$and' },
      { type: 'field', operator: 'eq', depth: 2, parent: '$or' },
    ]);
  });
});
