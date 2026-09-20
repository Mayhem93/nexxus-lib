import { describe, it, expect } from 'vitest';
import {
  NexxusSchemaValidator,
  type NexxusFieldDef,
  type NexxusModelDef
} from '@mayhem93/nexxus-core-lib';

const { validateValue, validateAgainstSchema } = NexxusSchemaValidator;

/**
 * Every `date` normalizes to an integer UNIX timestamp in SECONDS — the unit
 * `NexxusBaseModel` stamps `createdAt`/`updatedAt` with, so a document never
 * holds two different units in two fields.
 */
const EPOCH_SECONDS = Date.parse('2020-01-01T00:00:00.000Z') / 1000;

describe('NexxusSchemaValidator.validateValue — primitives', () => {
  it('accepts and returns a valid string', () => {
    expect(validateValue('hi', { type: 'string' }, 'f')).toBe('hi');
  });

  it('rejects a non-string', () => {
    expect(() => validateValue(5, { type: 'string' }, 'f')).toThrow(/Expected string at path "f"/);
  });

  it('accepts an integer, rejects a float and a non-number', () => {
    expect(validateValue(7, { type: 'int' }, 'f')).toBe(7);
    expect(() => validateValue(7.5, { type: 'int' }, 'f')).toThrow(/Expected integer/);
    expect(() => validateValue('7', { type: 'int' }, 'f')).toThrow(/Expected integer/);
  });

  it('accepts a finite float, rejects a non-finite number and a non-number', () => {
    expect(validateValue(1.25, { type: 'float' }, 'f')).toBe(1.25);
    expect(validateValue(4, { type: 'float' }, 'f')).toBe(4); // integers are valid floats
    expect(() => validateValue(Infinity, { type: 'float' }, 'f')).toThrow(/Expected float/);
    expect(() => validateValue(NaN, { type: 'float' }, 'f')).toThrow(/Expected float/);
    expect(() => validateValue('x', { type: 'float' }, 'f')).toThrow(/Expected float/);
  });

  it('accepts a boolean, rejects a non-boolean', () => {
    expect(validateValue(true, { type: 'boolean' }, 'f')).toBe(true);
    expect(() => validateValue('true', { type: 'boolean' }, 'f')).toThrow(/Expected boolean/);
  });

  it('throws on an unknown field type', () => {
    expect(() => validateValue('x', { type: 'weird' } as never, 'f')).toThrow(/Unknown field type at path "f"/);
  });
});

describe('NexxusSchemaValidator.validateValue — date normalization', () => {
  const date: NexxusFieldDef = { type: 'date' };

  it('passes a finite number through as already-seconds', () => {
    // A bare number is taken to be in the canonical unit already. It has to be:
    // 1577836800 is a valid instant read as either seconds or milliseconds, so
    // there is nothing to detect and a heuristic would eventually be wrong.
    expect(validateValue(EPOCH_SECONDS, date, 'when')).toBe(EPOCH_SECONDS);
  });

  it('reads a numeric string as seconds too', () => {
    expect(validateValue(String(EPOCH_SECONDS), date, 'when')).toBe(EPOCH_SECONDS);
  });

  it('floors a fractional timestamp', () => {
    expect(validateValue(EPOCH_SECONDS + 0.9, date, 'when')).toBe(EPOCH_SECONDS);
  });

  it('parses an ISO string to a floored integer timestamp', () => {
    expect(validateValue('2020-01-01T00:00:00.000Z', date, 'when'))
      .toBe(EPOCH_SECONDS);
  });

  it('rejects a non-numeric, unparseable string', () => {
    expect(() => validateValue('not-a-date', date, 'when')).toThrow(/Expected valid date at path "when"/);
  });

  it('rejects a NaN number', () => {
    expect(() => validateValue(NaN, date, 'when')).toThrow(/Expected valid date/);
  });

  it('accepts a Date, converting its milliseconds to seconds', () => {
    // The natural thing for server-side code to build a patch with — three of
    // the four internal `updatedAt` patch sites did exactly this.
    expect(validateValue(new Date('2020-01-01T00:00:00.000Z'), date, 'when')).toBe(EPOCH_SECONDS);
  });

  it('rejects an Invalid Date', () => {
    // `new Date('garbage')` is still a Date; its time is NaN.
    expect(() => validateValue(new Date('not-a-date'), date, 'when')).toThrow(/Invalid Date/);
  });

  it('rejects a non-string, non-number, non-Date value', () => {
    expect(() => validateValue(true, date, 'when')).toThrow(/Expected valid date/);
    expect(() => validateValue({}, date, 'when')).toThrow(/Expected valid date/);
  });
});

describe('NexxusSchemaValidator.validateValue — object', () => {
  const objDef: NexxusFieldDef = {
    type: 'object',
    properties: {
      city:  { type: 'string', required: true },
      zip:   { type: 'int' },
      label: { type: 'string', nullable: true },
    },
  };

  it('validates nested fields and returns a normalized copy', () => {
    const input = { city: 'Cluj', zip: 400000 };
    const out = validateValue(input, objDef, 'addr') as Record<string, unknown>;

    expect(out).toEqual({ city: 'Cluj', zip: 400000 });
    expect(out).not.toBe(input); // shallow copy, not the same reference
  });

  it('rejects a nested field the properties do not declare', () => {
    // No reserved-name exemption down here — system fields only live at the
    // root of a model, so `id` inside a nested object is just undeclared.
    expect(() => validateValue({ city: 'X', extra: 'nope' }, objDef, 'addr'))
      .toThrow(/Field\(s\) "extra" at path "addr" are not declared in the schema/);
    expect(() => validateValue({ city: 'X', id: 'nope' }, objDef, 'addr'))
      .toThrow(/not declared in the schema/);
  });

  it('rejects a non-object (null / array / primitive)', () => {
    expect(() => validateValue(null, objDef, 'addr')).toThrow(/Expected object at path "addr"/);
    expect(() => validateValue([], objDef, 'addr')).toThrow(/Expected object at path "addr"/);
    expect(() => validateValue('x', objDef, 'addr')).toThrow(/Expected object at path "addr"/);
  });

  it('rejects a missing required nested field', () => {
    expect(() => validateValue({ zip: 1 }, objDef, 'addr')).toThrow(/Required field "addr.city" is missing/);
  });

  it('skips an absent optional nested field', () => {
    const out = validateValue({ city: 'X' }, objDef, 'addr') as Record<string, unknown>;

    expect('zip' in out).toBe(false);
  });

  it('keeps null on a nullable nested field, rejects null on a non-nullable one', () => {
    const out = validateValue({ city: 'X', label: null }, objDef, 'addr') as Record<string, unknown>;

    expect(out.label).toBeNull();
    expect(() => validateValue({ city: null }, objDef, 'addr')).toThrow(/Field "addr.city" cannot be null/);
  });
});

describe('NexxusSchemaValidator.validateValue — array', () => {
  it('validates a primitive array element-by-element', () => {
    const def: NexxusFieldDef = { type: 'array', arrayType: 'int' };

    expect(validateValue([1, 2, 3], def, 'nums')).toEqual([1, 2, 3]);
    expect(() => validateValue([1, 'two'], def, 'nums')).toThrow(/Expected integer at path "nums\[1\]"/);
  });

  it('normalizes date elements inside a primitive array', () => {
    const def: NexxusFieldDef = { type: 'array', arrayType: 'date' };

    expect(validateValue(['2020-01-01T00:00:00.000Z'], def, 'dates'))
      .toEqual([EPOCH_SECONDS]);
  });

  it('validates an array of objects against its properties', () => {
    const def: NexxusFieldDef = {
      type: 'array',
      arrayType: 'object',
      properties: { name: { type: 'string', required: true } },
    };

    expect(validateValue([{ name: 'a' }, { name: 'b' }], def, 'items')).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(() => validateValue([{}], def, 'items')).toThrow(/Required field "items\[0\].name" is missing/);
  });

  it('rejects a non-array value', () => {
    expect(() => validateValue('nope', { type: 'array', arrayType: 'string' }, 'tags'))
      .toThrow(/Expected array at path "tags"/);
  });

  it('rejects an array-of-objects field missing its properties definition', () => {
    const def = { type: 'array', arrayType: 'object' } as never;

    expect(() => validateValue([{}], def, 'items')).toThrow(/Array of objects at "items" is missing properties definition/);
  });
});

describe('NexxusSchemaValidator.validateAgainstSchema', () => {
  const modelDef: NexxusModelDef = {
    name: { type: 'string', required: true },
    age:  { type: 'int' },
    nick: { type: 'string', nullable: true },
    when: { type: 'date' },
  };

  it('rejects a non-object / array / null input', () => {
    expect(() => validateAgainstSchema(null as never, modelDef)).toThrow(/input must be a non-null object/);
    expect(() => validateAgainstSchema([] as never, modelDef)).toThrow(/input must be a non-null object/);
    expect(() => validateAgainstSchema('x' as never, modelDef)).toThrow(/input must be a non-null object/);
  });

  it('rejects user-supplied system-managed "version"', () => {
    expect(() => validateAgainstSchema({ name: 'a', version: 2 }, modelDef))
      .toThrow(/Field "version" is a system-managed Nexxus field/);
  });

  it('rejects a missing required field', () => {
    expect(() => validateAgainstSchema({ age: 5 }, modelDef)).toThrow(/Required field "name" is missing/);
  });

  it('normalizes declared values without mutating the input', () => {
    const input = { name: 'a', when: '2020-01-01T00:00:00.000Z' };
    const out = validateAgainstSchema(input, modelDef);

    expect(out).toEqual({ name: 'a', when: EPOCH_SECONDS });
    // input untouched — the date string is still a string on the original object
    expect(input.when).toBe('2020-01-01T00:00:00.000Z');
  });

  it('rejects fields the schema does not declare, naming all of them', () => {
    expect(() => validateAgainstSchema({ name: 'a', extra: 1, alsoExtra: 2 }, modelDef))
      .toThrow(/Field\(s\) "extra", "alsoExtra" are not declared in the schema/);
  });

  /**
   * The reserved names are set by the API/Worker at construction and an
   * application schema is FORBIDDEN from declaring them, so they can never be
   * found in a modelDef — without this exemption every app-model write would
   * fail on its own `type`.
   */
  it('lets system-managed reserved fields through undeclared', () => {
    const input = { name: 'a', id: 'x', type: 'runs', appId: 'app1', userId: 'u1', createdAt: 1, updatedAt: 2 };

    expect(() => validateAgainstSchema(input, modelDef)).not.toThrow();
  });

  it('still rejects "version", which is reserved but never caller-settable', () => {
    expect(() => validateAgainstSchema({ name: 'a', version: 2 }, modelDef))
      .toThrow(/system-managed Nexxus field/);
  });

  it('skips absent optional fields (they do not appear in the result)', () => {
    const out = validateAgainstSchema({ name: 'a' }, modelDef);

    expect('age' in out).toBe(false);
  });

  it('keeps null on a nullable field, rejects null on a non-nullable field', () => {
    expect(validateAgainstSchema({ name: 'a', nick: null }, modelDef).nick).toBeNull();
    expect(() => validateAgainstSchema({ name: null }, modelDef)).toThrow(/Field "name" cannot be null/);
  });

  it('treats an explicit undefined as absent — required throws; an optional undefined is copied through unvalidated', () => {
    expect(() => validateAgainstSchema({ name: undefined }, modelDef)).toThrow(/Required field "name" is missing/);
    // The `{...data}` copy carries the key over; the absent-check only skips
    // *validating* it, so it survives as undefined rather than being dropped.
    expect(validateAgainstSchema({ name: 'a', age: undefined }, modelDef).age).toBeUndefined();
  });
});
