import { NexxusException } from '@mayhem93/nexxus-core-lib';

enum NexxusDatabaseExceptions {
  DB_ITEMS_FAILED = 'DatabaseItemsFailedException'
};

export class NexxusDatabaseException extends NexxusException {
  constructor(name: string, message: string) {
    super(name, message);
  }
}

/** One item a database call couldn't complete, and why. */
export type NexxusDatabaseItemFailure = {
  id: string;
  reason: string;
  /** Whether the database would fail it the same way again: it refused the data itself. */
  terminal: boolean;
};

/**
 * Items of a database call failed for a reason other than not existing.
 * Terminal when every one of them is — retrying the same data can't succeed.
 */
export class NexxusDatabaseItemsFailedException extends NexxusDatabaseException {
  public readonly terminal: boolean;
  public readonly failures: ReadonlyArray<NexxusDatabaseItemFailure>;

  constructor(operation: string, failures: Array<NexxusDatabaseItemFailure>) {
    super(
      NexxusDatabaseExceptions.DB_ITEMS_FAILED,
      `${operation} failed for ${failures.map(f => `"${f.id}" (${f.reason})`).join(', ')}`
    );

    this.failures = failures;
    this.terminal = failures.length > 0 && failures.every(f => f.terminal);
  }
}
