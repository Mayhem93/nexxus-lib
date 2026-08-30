import { describe, it, expect } from 'vitest';
import {
  NexxusAppModel,
  type INexxusAppModel,
  type NexxusApplicationSchema
} from '@mayhem93/nexxus-core-lib';

const SCHEMA: NexxusApplicationSchema = {
  runs: {
    fields: {
      title: { type: 'string', required: true },
      when:  { type: 'date' },
      note:  { type: 'string' },
    },
  },
};

/** A minimal valid props payload for the `runs` model, with per-test overrides. */
const props = (overrides: Partial<INexxusAppModel> = {}): INexxusAppModel => ({
  appId: 'app1',
  type: 'runs',
  title: 'Morning run',
  ...overrides,
});

describe('NexxusAppModel — validated construction', () => {
  it('constructs and normalizes values against the app schema', () => {
    const model = new NexxusAppModel(props({ when: '2020-01-01T00:00:00.000Z' }), SCHEMA);
    const data = model.getData();

    expect(data.appId).toBe('app1');
    expect(data.type).toBe('runs');
    expect(data.title).toBe('Morning run');
    // date string normalized to an integer timestamp
    expect(data.when).toBe(Date.parse('2020-01-01T00:00:00.000Z'));
  });

  it('applies BaseModel defaults (id + timestamps) after normalization', () => {
    const model = new NexxusAppModel(props(), SCHEMA);
    const data = model.getData();

    expect(typeof data.id).toBe('string');
    expect(typeof data.createdAt).toBe('number');
    expect(typeof data.updatedAt).toBe('number');
  });

  it('requires an appId', () => {
    expect(() => new NexxusAppModel(props({ appId: undefined as never }), SCHEMA))
      .toThrow(/AppModel requires AppId/);
  });

  it('throws InvalidSchemaDataException for an unknown model type', () => {
    const err = (() => {
      try { new NexxusAppModel(props({ type: 'ghost' }), SCHEMA); }
      catch (e) { return e as Error; }
    })();

    expect(err?.name).toBe('InvalidSchemaDataException');
    expect(err?.message).toMatch(/Unknown app model type "ghost" for app "app1"/);
  });

  it('enforces required fields declared in the schema', () => {
    expect(() => new NexxusAppModel(props({ title: undefined }), SCHEMA))
      .toThrow(/Required field "title" is missing/);
  });

  it('rejects a user-supplied system-managed version', () => {
    expect(() => new NexxusAppModel(props({ version: 3 }), SCHEMA))
      .toThrow(/Field "version" is a system-managed Nexxus field/);
  });

  it('bubbles a field type error from the validator', () => {
    expect(() => new NexxusAppModel(props({ title: 123 as never }), SCHEMA))
      .toThrow(/Expected string at path "title"/);
  });
});

describe('NexxusAppModel — trusted (unvalidated) construction', () => {
  it('skips validation when appSchema is null (raw values preserved)', () => {
    const model = new NexxusAppModel(props({ when: '2020-01-01T00:00:00.000Z' }), null);

    // Not normalized — the date string is kept verbatim.
    expect(model.getData().when).toBe('2020-01-01T00:00:00.000Z');
  });

  it('does not validate the model type or field data on the trusted path', () => {
    expect(() => new NexxusAppModel(props({ type: 'ghost', title: 123 as never, version: 9 }), null))
      .not.toThrow();
  });

  it('still requires an appId even on the trusted path', () => {
    expect(() => new NexxusAppModel(props({ appId: undefined as never }), null))
      .toThrow(/AppModel requires AppId/);
  });

  it('preserves caller-supplied id / timestamps / version', () => {
    const model = new NexxusAppModel(
      props({ id: 'fixed-id', createdAt: 111, updatedAt: 222, version: 5 }),
      null,
    );
    const data = model.getData();

    expect(data.id).toBe('fixed-id');
    expect(data.createdAt).toBe(111);
    expect(data.updatedAt).toBe(222);
    expect(data.version).toBe(5);
  });
});

describe('NexxusAppModel.fromStorage', () => {
  it('hydrates via the trusted path (no validation)', () => {
    const model = NexxusAppModel.fromStorage(props({ type: 'ghost', when: '2020-01-01T00:00:00.000Z' }));

    expect(model).toBeInstanceOf(NexxusAppModel);
    expect(model.getData().when).toBe('2020-01-01T00:00:00.000Z');
  });

  it('still enforces the appId requirement', () => {
    expect(() => NexxusAppModel.fromStorage(props({ appId: undefined as never })))
      .toThrow(/AppModel requires AppId/);
  });
});
