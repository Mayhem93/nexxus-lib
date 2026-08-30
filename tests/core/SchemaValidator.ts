import { describe, it, expect } from 'vitest';
import {
  NexxusSchemaValidator,
  type NexxusFieldDef,
  type NexxusModelDef
} from '@mayhem93/nexxus-core-lib';

const { validateValue, validateAgainstSchema } = NexxusSchemaValidator;

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

  it('passes a finite numeric timestamp through unchanged', () => {
    expect(validateValue(1577836800000, date, 'when')).toBe(1577836800000);
  });

  it('parses a numeric string to a number', () => {
    expect(validateValue('1577836800000', date, 'when')).toBe(1577836800000);
  });

  it('parses an ISO string to a floored integer timestamp', () => {
    expect(validateValue('2020-01-01T00:00:00.000Z', date, 'when'))
      .toBe(Date.parse('2020-01-01T00:00:00.000Z'));
  });

  it('rejects a non-numeric, unparseable string', () => {
    expect(() => validateValue('not-a-date', date, 'when')).toThrow(/Expected valid date at path "when"/);
  });

  it('rejects a NaN number', () => {
    expect(() => validateValue(NaN, date, 'when')).toThrow(/Expected valid date/);
  });

  it('rejects a non-string, non-number value', () => {
    expect(() => validateValue(true, date, 'when')).toThrow(/Expected valid date/);
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
    const input = { city: 'Cluj', zip: 400000, extra: 'kept' };
    const out = validateValue(input, objDef, 'addr') as Record<string, unknown>;

    expect(out).toEqual({ city: 'Cluj', zip: 400000, extra: 'kept' });
    expect(out).not.toBe(input); // shallow copy, not the same reference
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
      .toEqual([Date.parse('2020-01-01T00:00:00.000Z')]);
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

  it('normalizes declared values and passes unknown fields through, without mutating the input', () => {
    const input = { name: 'a', when: '2020-01-01T00:00:00.000Z', extra: 'kept' };
    const out = validateAgainstSchema(input, modelDef);

    expect(out).toEqual({ name: 'a', when: Date.parse('2020-01-01T00:00:00.000Z'), extra: 'kept' });
    // input untouched — the date string is still a string on the original object
    expect(input.when).toBe('2020-01-01T00:00:00.000Z');
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
