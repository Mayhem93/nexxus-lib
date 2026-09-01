import { describe, it, expect } from 'vitest';
import { NexxusDatabaseUpdateConflictException } from '@mayhem93/nexxus-database-lib';

describe('NexxusDatabaseUpdateConflictException', () => {
  it('carries the conflict message and id/appId attributes', () => {
    const err = new NexxusDatabaseUpdateConflictException('version conflict', { id: 'doc1', appId: 'app1' });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DatabaseUpdateConflictException');
    expect(err.message).toBe('version conflict');
    expect(err.id).toBe('doc1');
    expect(err.appId).toBe('app1');
  });

  it('allows a null appId (deployment-scoped models)', () => {
    const err = new NexxusDatabaseUpdateConflictException('conflict', { id: 'setting1', appId: null });

    expect(err.appId).toBeNull();
  });
});
