import { describe, it, expect } from 'vitest';
import {
  NexxusJsonPatch,
  type NexxusJsonPatchConstructor,
  type NexxusModelDef
} from '@mayhem93/nexxus-core-lib';

/**
 * A model schema exercising every field kind JsonPatch cares about:
 * primitives, a date (for normalization), primitive + object arrays, and a
 * nested object.
 */
/** Dates normalize to integer UNIX SECONDS — see the SchemaValidator suite. */
const EPOCH_SECONDS = Date.parse('2020-01-01T00:00:00.000Z') / 1000;

const SCHEMA: NexxusModelDef = {
  title:  { type: 'string' },
  count:  { type: 'int' },
  ratio:  { type: 'float' },
  active: { type: 'boolean' },
  when:   { type: 'date' },
  tags:   { type: 'array', arrayType: 'string' },
  scores: { type: 'array', arrayType: 'int' },
  days:   { type: 'array', arrayType: 'date' },
  items:  { type: 'array', arrayType: 'object', properties: { name: { type: 'string', required: true } } },
  meta:   { type: 'object', properties: { region: { type: 'string' }, level: { type: 'int' } } },
};

/** Build a patch constructor payload with sensible defaults + per-test overrides. */
const patchInput = (overrides: Partial<NexxusJsonPatchConstructor> = {}): NexxusJsonPatchConstructor => ({
  op: 'replace',
  path: ['title'],
  value: ['hello'],
  metadata: { type: 'runs', id: 'obj1', appId: 'app1' },
  ...overrides,
} as NexxusJsonPatchConstructor);

/** Construct a patch from defaults + overrides. */
const makePatch = (overrides: Partial<NexxusJsonPatchConstructor> = {}): NexxusJsonPatch =>
  new NexxusJsonPatch(patchInput(overrides));

describe('NexxusJsonPatch constructor', () => {
  it('rejects a non-object / null / array payload', () => {
    expect(() => new NexxusJsonPatch(null as never)).toThrow(/Invalid patch format/);
    expect(() => new NexxusJsonPatch('nope' as never)).toThrow(/Invalid patch format/);
    expect(() => new NexxusJsonPatch([] as never)).toThrow(/Invalid patch format/);
  });

  it('rejects an unsupported operation', () => {
    expect(() => makePatch({ op: 'move' as never })).toThrow(/Unsupported JSON Patch operation: move/);
  });

  it('rejects mismatched path/value array lengths', () => {
    expect(() => makePatch({ path: ['title', 'count'], value: ['x'] }))
      .toThrow(/Path and value arrays must have the same length/);
  });

  it('requires a string metadata.type', () => {
    expect(() => makePatch({ metadata: { id: 'o', appId: 'a' } as never })).toThrow(/must include type/);
    expect(() => makePatch({ metadata: { type: 5, id: 'o', appId: 'a' } as never })).toThrow(/must include type/);
  });

  it('requires appId for non-setting models', () => {
    expect(() => makePatch({ metadata: { type: 'runs', id: 'o' } as never })).toThrow(/must include appId/);
    expect(() => makePatch({ metadata: { type: 'runs', id: 'o', appId: 7 } as never })).toThrow(/must include appId/);
  });

  it('does NOT require appId for the deployment-scoped "setting" model', () => {
    expect(() => new NexxusJsonPatch(patchInput({ metadata: { type: 'setting', id: 's1' } as never }))).not.toThrow();
  });

  it('requires a string metadata.id', () => {
    expect(() => makePatch({ metadata: { type: 'runs', appId: 'a' } as never })).toThrow(/must include id/);
    expect(() => makePatch({ metadata: { type: 'runs', appId: 'a', id: 9 } as never })).toThrow(/must include id/);
  });

  it('constructs an un-validated patch', () => {
    expect(makePatch().isValid()).toBe(false);
  });
});

describe('NexxusJsonPatch get() / isValid()', () => {
  it('get() throws before validation', () => {
    expect(() => makePatch().get()).toThrow(/Cannot get JSON Patch before validation/);
  });

  it('get() returns the internal patch after validation, isValid() flips to true', () => {
    const patch = makePatch();

    patch.validate(SCHEMA);

    expect(patch.isValid()).toBe(true);
    expect(patch.get()).toMatchObject({
      op: 'replace',
      path: ['title'],
      value: ['hello'],
      metadata: { type: 'runs', id: 'obj1', appId: 'app1', pathFieldTypes: ['string'] },
    });
  });
});

describe('NexxusJsonPatch validate() — path resolution', () => {
  it('rejects patching the system-managed "version" field (top-level and nested)', () => {
    expect(() => makePatch({ path: ['version'], value: [2] }).validate(SCHEMA))
      .toThrow(/Cannot patch system-managed field "version"/);
    expect(() => makePatch({ path: ['version.sub'], value: [2] }).validate(SCHEMA))
      .toThrow(/Cannot patch system-managed field "version"/);
  });

  it('rejects an unknown top-level field', () => {
    expect(() => makePatch({ path: ['ghost'], value: ['x'] }).validate(SCHEMA))
      .toThrow(/Path "ghost" does not exist in model "runs"/);
  });

  it('rejects descending into a primitive field', () => {
    expect(() => makePatch({ path: ['title.sub'], value: ['x'] }).validate(SCHEMA))
      .toThrow(/does not exist in model/);
  });

  it('rejects descending into a primitive array', () => {
    expect(() => makePatch({ path: ['tags.sub'], value: ['x'] }).validate(SCHEMA))
      .toThrow(/does not exist in model/);
  });

  it('resolves a nested object field', () => {
    const patch = makePatch({ path: ['meta.level'], value: [4] });

    expect(() => patch.validate(SCHEMA)).not.toThrow();
    expect(patch.get().metadata.pathFieldTypes).toEqual(['int']);
  });

  it('rejects descending into an array-of-objects element field (no element-path syntax)', () => {
    // Arrays are leaves: you can replace/append/prepend the whole array, but
    // there is no path syntax to target an element's field.
    expect(() => makePatch({ path: ['items.name'], value: ['crate'] }).validate(SCHEMA))
      .toThrow(/does not exist in model/);
  });

  it('allows patching the injected universal updatedAt field', () => {
    const patch = makePatch({ op: 'incr', path: ['updatedAt'], value: [1000] });

    expect(() => patch.validate(SCHEMA)).not.toThrow();
    expect(patch.get().metadata.pathFieldTypes).toEqual(['date']);
  });
});

describe('NexxusJsonPatch validate() — operation/type gating', () => {
  it('rejects an operation not allowed on the target field type', () => {
    expect(() => makePatch({ op: 'incr', path: ['title'], value: ['x'] }).validate(SCHEMA))
      .toThrow(/Operation "incr" not allowed on type "string"/);
    expect(() => makePatch({ op: 'append', path: ['count'], value: [1] }).validate(SCHEMA))
      .toThrow(/Operation "append" not allowed on type "int"/);
  });

  it('rewraps a SchemaValidator type error as InvalidJsonPatchException', () => {
    // replace on a string field with a number → SchemaValidator throws
    // InvalidSchemaDataException, which validate() rewraps.
    const err = (() => {
      try { makePatch({ path: ['title'], value: [123] }).validate(SCHEMA); }
      catch (e) { return e as Error; }
    })();

    expect(err?.name).toBe('InvalidJsonPatchException');
    expect(err?.message).toMatch(/Expected string/);
  });

  it('validates + records field types across a multi-path patch', () => {
    const patch = makePatch({ op: 'replace', path: ['title', 'count', 'active'], value: ['hi', 5, true] });

    patch.validate(SCHEMA);

    expect(patch.get().metadata.pathFieldTypes).toEqual(['string', 'int', 'boolean']);
    expect(patch.get().value).toEqual(['hi', 5, true]);
  });
});

describe('NexxusJsonPatch validate() — value normalization', () => {
  it('normalizes an ISO date string to an integer timestamp (replace)', () => {
    const patch = makePatch({ op: 'replace', path: ['when'], value: ['2020-01-01T00:00:00.000Z'] });

    patch.validate(SCHEMA);

    expect(patch.get().value[0]).toBe(EPOCH_SECONDS);
  });

  it('normalizes a date on incr/decr as well', () => {
    const patch = makePatch({ op: 'decr', path: ['when'], value: ['1577836800000'] });

    patch.validate(SCHEMA);

    expect(patch.get().value[0]).toBe(1577836800000);
  });
});

describe('NexxusJsonPatch validate() — append', () => {
  it('appends a primitive element to a primitive array', () => {
    const patch = makePatch({ op: 'append', path: ['tags'], value: ['urgent'] });

    patch.validate(SCHEMA);

    expect(patch.get().value).toEqual(['urgent']);
    expect(patch.get().metadata.pathFieldTypes).toEqual(['array']);
  });

  it('appends and validates an object element to an array-of-objects', () => {
    const patch = makePatch({ op: 'append', path: ['items'], value: [{ name: 'crate' }] });

    patch.validate(SCHEMA);

    expect(patch.get().value[0]).toEqual({ name: 'crate' });
  });

  it('rejects an object element missing a required property', () => {
    expect(() => makePatch({ op: 'append', path: ['items'], value: [{}] }).validate(SCHEMA))
      .toThrow(/Required field "items.name" is missing/);
  });

  it('appends a substring to a string field', () => {
    const patch = makePatch({ op: 'append', path: ['title'], value: ['!'] });

    patch.validate(SCHEMA);

    expect(patch.get().value).toEqual(['!']);
  });

  it('rejects a non-string append onto a string field', () => {
    expect(() => makePatch({ op: 'append', path: ['title'], value: [5] }).validate(SCHEMA))
      .toThrow(/Value for append at path "title" must be a string/);
  });

  it('rejects (and re-throws) append to an array-of-objects missing its properties def', () => {
    const brokenSchema: NexxusModelDef = {
      items: { type: 'array', arrayType: 'object' } as never, // no properties
    };

    const err = (() => {
      try { makePatch({ op: 'append', path: ['items'], value: [{}] }).validate(brokenSchema); }
      catch (e) { return e as Error; }
    })();

    expect(err?.name).toBe('InvalidJsonPatchException');
    expect(err?.message).toMatch(/missing properties definition/);
  });
});

describe('NexxusJsonPatch validate() — prepend', () => {
  it('prepends a primitive element to a primitive array', () => {
    const patch = makePatch({ op: 'prepend', path: ['scores'], value: [10] });

    patch.validate(SCHEMA);

    expect(patch.get().value).toEqual([10]);
  });

  it('prepends and validates an object element to an array-of-objects', () => {
    const patch = makePatch({ op: 'prepend', path: ['items'], value: [{ name: 'first' }] });

    patch.validate(SCHEMA);

    expect(patch.get().value[0]).toEqual({ name: 'first' });
  });

  it('rejects a non-string prepend onto a string field', () => {
    expect(() => makePatch({ op: 'prepend', path: ['title'], value: [5] }).validate(SCHEMA))
      .toThrow(/Value for prepend at path "title" must be a string/);
  });

  it('rejects (and re-throws) prepend to an array-of-objects missing its properties def', () => {
    const brokenSchema: NexxusModelDef = {
      items: { type: 'array', arrayType: 'object' } as never,
    };

    expect(() => makePatch({ op: 'prepend', path: ['items'], value: [{}] }).validate(brokenSchema))
      .toThrow(/missing properties definition/);
  });
});

describe('NexxusJsonPatch validate() — remove', () => {
  it('removes by index from any array, an array of objects included', () => {
    const patch = makePatch({ op: 'remove', path: ['tags', 'items'], value: [{ i: 0 }, { i: 3 }] });

    patch.validate(SCHEMA);

    expect(patch.get().value).toEqual([{ i: 0 }, { i: 3 }]);
    expect(patch.get().metadata.pathFieldTypes).toEqual(['array', 'array']);
  });

  it('removes by value from an array of primitives, normalized like an appended element', () => {
    const patch = makePatch({ op: 'remove', path: ['tags', 'days'], value: [{ v: 'urgent' }, { v: '2020-01-01T00:00:00.000Z' }] });

    patch.validate(SCHEMA);

    expect(patch.get().value).toEqual([{ v: 'urgent' }, { v: EPOCH_SECONDS }]);
  });

  it('refuses removing by value from an array of objects', () => {
    expect(() => makePatch({ op: 'remove', path: ['items'], value: [{ v: { name: 'crate' } }] }).validate(SCHEMA))
      .toThrow(/can only be removed by index/);
  });

  it('refuses an element the array could not hold', () => {
    expect(() => makePatch({ op: 'remove', path: ['scores'], value: [{ v: 'ten' }] }).validate(SCHEMA))
      .toThrow(/Expected integer/);
    expect(() => makePatch({ op: 'remove', path: ['tags'], value: [{ v: null }] }).validate(SCHEMA))
      .toThrow(/Expected string/);
  });

  it('refuses an index that is not a non-negative integer', () => {
    for (const i of [-1, 1.5, '0', null, 2 ** 53]) {
      expect(() => makePatch({ op: 'remove', path: ['tags'], value: [{ i }] }).validate(SCHEMA))
        .toThrow(/must be a non-negative integer/);
    }
  });

  it('refuses a value that is not exactly one of { v } and { i }', () => {
    for (const value of ['urgent', 0, null, [], {}, { v: 'a', i: 0 }, { x: 1 }]) {
      expect(() => makePatch({ op: 'remove', path: ['tags'], value: [value] }).validate(SCHEMA))
        .toThrow(/must be either \{ v: <element> \} or \{ i: <index> \}/);
    }
  });

  it('refuses remove on a field that is not an array', () => {
    expect(() => makePatch({ op: 'remove', path: ['title'], value: [{ i: 0 }] }).validate(SCHEMA))
      .toThrow(/Operation "remove" not allowed on type "string"/);
  });
});
