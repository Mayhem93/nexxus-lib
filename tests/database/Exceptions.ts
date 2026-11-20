import { describe, it, expect } from 'vitest';
import {
  NexxusDatabaseItemsFailedException,
  NexxusDatabaseException
} from '@mayhem93/nexxus-database-lib';

describe('NexxusDatabaseItemsFailedException', () => {
  it('names every failed item and why', () => {
    const err = new NexxusDatabaseItemsFailedException('updateItems', [
      { id: 'r1', reason: 'version_conflict_engine_exception', terminal: false },
      { id: 'r2', reason: 'script_exception: runtime error', terminal: true },
    ]);

    expect(err).toBeInstanceOf(NexxusDatabaseException);
    expect(err.name).toBe('DatabaseItemsFailedException');
    expect(err.message).toBe('updateItems failed for "r1" (version_conflict_engine_exception), "r2" (script_exception: runtime error)');
    expect(err.failures).toHaveLength(2);
  });

  /**
   * Retrying the message retries every item in it, so a single failure that
   * could pass later makes the whole of it worth retrying.
   */
  it('is terminal only when every failure is', () => {
    const refused = { id: 'r1', reason: 'mapper_parsing_exception', terminal: true };
    const busy = { id: 'r2', reason: 'es_rejected_execution_exception', terminal: false };

    expect(new NexxusDatabaseItemsFailedException('createItems', [ refused ]).terminal).toBe(true);
    expect(new NexxusDatabaseItemsFailedException('createItems', [ refused, busy ]).terminal).toBe(false);
  });

  it('is alreadyExists only when every failure is an id that is already stored', () => {
    const stored = { id: 'r1', reason: 'version_conflict_engine_exception', terminal: true, alreadyExists: true };
    const refused = { id: 'r2', reason: 'mapper_parsing_exception', terminal: true };

    expect(new NexxusDatabaseItemsFailedException('createItems', [ stored ]).alreadyExists).toBe(true);
    expect(new NexxusDatabaseItemsFailedException('createItems', [ stored, refused ]).alreadyExists).toBe(false);
    expect(new NexxusDatabaseItemsFailedException('createItems', []).alreadyExists).toBe(false);
  });
});
