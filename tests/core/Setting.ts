import { describe, it, expect } from 'vitest';
import { NexxusSetting, type INexxusSetting } from '@mayhem93/nexxus-core-lib';

/** A valid setting payload (id is a registered name, value is a JSON string). */
const makeSetting = (overrides: Record<string, unknown> = {}): INexxusSetting => ({
  type: 'setting',
  id: 'pipeline',
  value: JSON.stringify({ transport: 'ws' }),
  ...overrides,
} as INexxusSetting);

describe('NexxusSetting constructor', () => {
  it('constructs a valid setting, forces type=setting, and keeps the caller id', () => {
    const setting = new NexxusSetting(makeSetting());
    const data = setting.getData();

    expect(data.type).toBe('setting');
    expect(data.id).toBe('pipeline'); // id is NOT auto-generated — it doubles as the name
    expect(typeof data.createdAt).toBe('number');
    expect(typeof data.updatedAt).toBe('number');
  });

  it('requires a non-empty string id', () => {
    expect(() => new NexxusSetting(makeSetting({ id: undefined }))).toThrow(/"id" is required and must be a non-empty string/);
    expect(() => new NexxusSetting(makeSetting({ id: '' }))).toThrow(/"id" is required and must be a non-empty string/);
    expect(() => new NexxusSetting(makeSetting({ id: 5 }))).toThrow(/"id" is required and must be a non-empty string/);
  });

  it('rejects an unregistered setting name', () => {
    expect(() => new NexxusSetting(makeSetting({ id: 'bogus' }))).toThrow(/NexxusSetting invalid\. Got "bogus"\./);
  });

  it('requires value to be a string', () => {
    expect(() => new NexxusSetting(makeSetting({ value: { transport: 'ws' } })))
      .toThrow(/"value" must be a string/);
    expect(() => new NexxusSetting(makeSetting({ value: undefined })))
      .toThrow(/"value" must be a string/);
  });
});

describe('NexxusSetting accessors', () => {
  it('getName returns the id (== the setting name)', () => {
    expect(new NexxusSetting(makeSetting()).getName()).toBe('pipeline');
  });

  it('getValue JSON-parses the stored value', () => {
    const setting = new NexxusSetting(makeSetting({ value: JSON.stringify({ transport: 'ws', workers: 3 }) }));

    expect(setting.getValue<{ transport: string; workers: number }>()).toEqual({ transport: 'ws', workers: 3 });
  });
});

describe('NexxusSetting statics', () => {
  it('isValidSettingName recognizes registered names only', () => {
    expect(NexxusSetting.isValidSettingName('pipeline')).toBe(true);
    expect(NexxusSetting.isValidSettingName('bogus')).toBe(false);
  });

  it('getModelSchema returns the setting schema (a copy)', () => {
    expect(NexxusSetting.getModelSchema()).toHaveProperty('value');
  });
});
