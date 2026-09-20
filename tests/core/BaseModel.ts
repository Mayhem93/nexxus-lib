import { describe, it, expect } from 'vitest';
import { NexxusBaseModel, MODEL_REGISTRY, type INexxusBaseModel } from '@mayhem93/nexxus-core-lib';

// NexxusBaseModel is abstract — a trivial concrete subclass exercises the base
// constructor behavior.
class TestModel extends NexxusBaseModel<INexxusBaseModel> {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('MODEL_REGISTRY', () => {
  it('maps each builtin model type to its own name', () => {
    expect(MODEL_REGISTRY).toEqual({
      application: 'application',
      user: 'user',
      setting: 'setting',
      acl: 'acl',
    });
  });
});

describe('NexxusBaseModel', () => {
  it('requires a "type"', () => {
    expect(() => new TestModel({} as INexxusBaseModel)).toThrow(/Model 'type' is required/);
  });

  it('auto-generates a uuid id when none is provided', () => {
    const model = new TestModel({ type: 'thing' });

    expect(model.getData().id).toMatch(UUID_RE);
  });

  it('keeps a caller-provided id', () => {
    const model = new TestModel({ type: 'thing', id: 'my-id' });

    expect(model.getData().id).toBe('my-id');
  });

  it('defaults createdAt/updatedAt to the current time in seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const model = new TestModel({ type: 'thing' });
    const after = Math.floor(Date.now() / 1000);

    expect(model.getData().createdAt).toBeGreaterThanOrEqual(before);
    expect(model.getData().createdAt).toBeLessThanOrEqual(after);
    expect(model.getData().updatedAt).toBeGreaterThanOrEqual(before);
    expect(model.getData().updatedAt).toBeLessThanOrEqual(after);
  });

  it('keeps caller-provided timestamps', () => {
    const model = new TestModel({ type: 'thing', createdAt: 100, updatedAt: 200 });

    expect(model.getData().createdAt).toBe(100);
    expect(model.getData().updatedAt).toBe(200);
  });

  it('getData returns the underlying data', () => {
    const model = new TestModel({ type: 'thing', id: 'x' });

    expect(model.getData().type).toBe('thing');
    expect(model.getData().id).toBe('x');
  });
});
