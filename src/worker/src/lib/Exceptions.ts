import { NexxusException } from '@mayhem93/nexxus-core-lib';

enum NexxusWorkerExceptions {
  UNSUPPORTED_EVENT = 'WorkerUnsupportedEventException'
};

/**
 * A queue message names an event the worker doesn't handle — typically one
 * published by a newer version of the service upstream. No retry changes that,
 * so the message is dead-lettered at once: kept in the queue's dead-letter
 * queue, where it has one, for a worker that handles the event.
 */
export class NexxusWorkerUnsupportedEventException extends NexxusException {
  public readonly terminal = true;

  constructor(message: string) {
    super(NexxusWorkerExceptions.UNSUPPORTED_EVENT, message);
  }
}
