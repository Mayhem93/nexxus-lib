import { describe, it, expect } from 'vitest';
import {
  NexxusException,
  ConnectionException,
  FatalErrorException,
  InvalidJsonPatchException,
  InvalidQueryFilterException,
  InvalidSchemaDataException,
  InvalidUserModelException,
  UnknownApplicationException,
  UnknownModelTypeException,
} from '@mayhem93/nexxus-core-lib';

/**
 * `terminal` is what the message queue reads to decide between retrying a
 * failed message and dead-lettering it at once.
 */
describe('NexxusException.terminal', () => {
  it('is false unless the exception says otherwise', () => {
    expect(new NexxusException('Custom', 'x').terminal).toBe(false);
    expect(new ConnectionException('x').terminal).toBe(false);
    expect(new FatalErrorException('x').terminal).toBe(false);
  });

  it('is true for data that will be just as invalid on every retry', () => {
    for (const err of [
      new InvalidJsonPatchException('x'),
      new InvalidQueryFilterException('x'),
      new InvalidSchemaDataException('x'),
      new InvalidUserModelException('x'),
      new UnknownApplicationException('x'),
      new UnknownModelTypeException('x'),
    ]) {
      expect(err.terminal, err.name).toBe(true);
    }
  });
});
