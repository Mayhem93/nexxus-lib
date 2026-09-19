import { describe, it, expect } from 'vitest';
import { NexxusUser, type INexxusUser } from '@mayhem93/nexxus-core-lib';

/** A minimal valid user payload, with per-test overrides. */
const makeUser = (overrides: Record<string, unknown> = {}): INexxusUser => ({
  type: 'user',
  appId: 'app1',
  username: 'alice',
  authProviders: ['local'],
  devices: [],
  userType: 'default',
  ...overrides,
} as INexxusUser);

describe('NexxusUser constructor', () => {
  it('constructs a valid user, forces type=user, and applies BaseModel defaults', () => {
    const user = new NexxusUser(makeUser({ type: 'somethingElse' } as never));
    const data = user.getData();

    expect(data.type).toBe('user');
    expect(data.username).toBe('alice');
    expect(typeof data.id).toBe('string');
    expect(typeof data.createdAt).toBe('number');
    expect(typeof data.updatedAt).toBe('number');
  });

  it('requires a string appId', () => {
    expect(() => new NexxusUser(makeUser({ appId: undefined }))).toThrow(/'appId' is required and must be a string/);
    expect(() => new NexxusUser(makeUser({ appId: 5 }))).toThrow(/'appId' is required and must be a string/);
  });

  it('requires a string username', () => {
    expect(() => new NexxusUser(makeUser({ username: undefined }))).toThrow(/'username' is required and must be a string/);
    expect(() => new NexxusUser(makeUser({ username: 5 }))).toThrow(/'username' is required and must be a string/);
  });

  it('accepts an absent or null password, rejects a non-string password', () => {
    expect(() => new NexxusUser(makeUser({ password: undefined }))).not.toThrow();
    expect(() => new NexxusUser(makeUser({ password: null }))).not.toThrow();
    expect(() => new NexxusUser(makeUser({ password: 'secret' }))).not.toThrow();
    expect(() => new NexxusUser(makeUser({ password: 123 }))).toThrow(/'password' must be a string if provided/);
  });

  it('requires authProviders to be an array of strings', () => {
    expect(() => new NexxusUser(makeUser({ authProviders: undefined }))).toThrow(/'authProviders' is required and must be an array of strings/);
    expect(() => new NexxusUser(makeUser({ authProviders: 'local' }))).toThrow(/'authProviders' is required and must be an array of strings/);
    expect(() => new NexxusUser(makeUser({ authProviders: ['local', 7] }))).toThrow(/'authProviders' is required and must be an array of strings/);
  });

  it('requires devices to be an array of strings', () => {
    expect(() => new NexxusUser(makeUser({ devices: undefined }))).toThrow(/'devices' must be an array of strings/);
    expect(() => new NexxusUser(makeUser({ devices: 'd1' }))).toThrow(/'devices' must be an array of strings/);
    expect(() => new NexxusUser(makeUser({ devices: ['d1', 9] }))).toThrow(/'devices' must be an array of strings/);
    expect(() => new NexxusUser(makeUser({ devices: ['d1', 'd2'] }))).not.toThrow();
  });

  it('requires a string userType', () => {
    expect(() => new NexxusUser(makeUser({ userType: 5 }))).toThrow(/'userType' must be a string/);
  });

  it('rejects a non-object details, accepts an object or absent details', () => {
    expect(() => new NexxusUser(makeUser({ details: 'nope' }))).toThrow(/'details' must be an object if provided/);
    expect(() => new NexxusUser(makeUser({ details: { age: 30 } }))).not.toThrow();
    expect(() => new NexxusUser(makeUser({ details: undefined }))).not.toThrow();
  });
});

describe('NexxusUser.getModelSchema', () => {
  it('returns the base user schema (a copy) with the default empty details field', () => {
    const schema = NexxusUser.getModelSchema();

    expect(schema).toHaveProperty('username');
    // `details` is a declared schema field with empty properties by default.
    expect(schema.details).toEqual({ type: 'object', required: false, properties: {} });
  });

  it('overlays a per-userType detail schema into details.properties', () => {
    const details = { license: { type: 'string' as const } };
    const schema = NexxusUser.getModelSchema(details);

    expect(schema.details).toEqual({ type: 'object', required: false, properties: details });
  });

  it('leaves the default empty details when passed null', () => {
    expect((NexxusUser.getModelSchema(null).details as { properties: unknown }).properties).toEqual({});
  });
});
