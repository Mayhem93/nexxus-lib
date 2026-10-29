import { NexxusException } from '@mayhem93/nexxus-core-lib';

enum NexxusMessageQueueExceptions {
  MQ_PUBLISH_FAILED = 'MessageQueuePublishException'
};

/**
 * The broker didn't confirm a message: there was no connection, it refused the
 * message, the connection went first, or no confirmation came in time. In the
 * last two cases the message may still have been delivered — it just wasn't
 * confirmed.
 */
export class NexxusMessageQueuePublishException extends NexxusException {
  constructor(message: string) {
    super(NexxusMessageQueueExceptions.MQ_PUBLISH_FAILED, message);
  }
}
