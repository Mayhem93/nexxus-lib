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
const SCHEMA: NexxusModelDef = {
  title:  { type: 'string' },
  count:  { type: 'int' },
  ratio:  { type: 'float' },
  active: { type: 'boolean' },
  when:   { type: 'date' },
  tags:   { type: 'array', arrayType: 'string' },
  scores: { type: 'array', arrayType: 'int' },
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
    expect(() => makePatch({ op: 'remove' as never })).toThrow(/Unsupported JSON Patch operation: remove/);
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

  it('constructs an un-validated patch (isValid=false, pathFieldTypes seeded empty)', () => {
    const patch = makePatch();

    expect(patch.isValid()).toBe(false);
    // get() is gated behind validation, but getPartialModel() reads the raw patch.
    expect(patch.getPartialModel()).toMatchObject({ id: 'obj1', type: 'runs', appId: 'app1', title: 'hello' });
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

describe('NexxusJsonPatch getPartialModel()', () => {
  it('includes appId for per-app models and sets each path/value', () => {
    const patch = makePatch({ path: ['count', 'meta.region'], value: [3, 'EU'] });

    expect(patch.getPartialModel()).toEqual({
      id: 'obj1',
      type: 'runs',
      appId: 'app1',
      count: 3,
      meta: { region: 'EU' },
    });
  });

  it('omits appId for deployment-scoped models', () => {
    const patch = new NexxusJsonPatch(patchInput({
      path: ['title'], value: ['x'], metadata: { type: 'setting', id: 's1' } as never,
    }));

    const partial = patch.getPartialModel();

    expect(partial).toEqual({ id: 's1', type: 'setting', title: 'x' });
    expect('appId' in partial).toBe(false);
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

    expect(patch.get().value[0]).toBe(Date.parse('2020-01-01T00:00:00.000Z'));
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
