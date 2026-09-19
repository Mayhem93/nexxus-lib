import { describe, it, expect, beforeEach } from 'vitest';
import { NexxusModelFieldCache } from '@mayhem93/nexxus-redis';
import { NEXXUS_PREFIX_LC } from '@mayhem93/nexxus-core-lib';
import { installFakeRedis } from './helpers';

describe('NexxusModelFieldCache', () => {
  beforeEach(() => { installFakeRedis(); });

  it('builds the cache key', () => {
    expect(NexxusModelFieldCache.getKey('m1')).toBe(`${NEXXUS_PREFIX_LC}:field-cache:m1`);
  });

  it('saves fields (JSON-encoded) and reads them back with their types intact', async () => {
    await new NexxusModelFieldCache('m1', { count: 3, owner: 'u1', active: true }).save();

    expect(await NexxusModelFieldCache.get('m1')).toEqual({ count: 3, owner: 'u1', active: true });
  });

  it('is a no-op when there are no fields to save', async () => {
    await new NexxusModelFieldCache('m1', {}).save();

    expect(await NexxusModelFieldCache.get('m1')).toBeNull();
  });

  it('reads a requested subset, omitting fields that are not cached', async () => {
    await new NexxusModelFieldCache('m1', { a: 1, b: 2 }).save();

    expect(await NexxusModelFieldCache.get('m1', ['a'])).toEqual({ a: 1 });
    expect(await NexxusModelFieldCache.get('m1', ['a', 'missing'])).toEqual({ a: 1 });
  });

  it('returns null when nothing is cached', async () => {
    expect(await NexxusModelFieldCache.get('ghost')).toBeNull();
    expect(await NexxusModelFieldCache.get('ghost', ['a'])).toBeNull();
  });

  it('removes the whole cache entry', async () => {
    await new NexxusModelFieldCache('m1', { a: 1 }).save();
    await NexxusModelFieldCache.remove('m1');

    expect(await NexxusModelFieldCache.get('m1')).toBeNull();
  });
});
