import { NexxusApiException, ServerErrorException, ServiceUnavailableException } from '../Exceptions';
import { NexxusApi } from '../Api';
import { FatalErrorException, NexxusException } from '@mayhem93/nexxus-core-lib';
import { NexxusDatabaseException } from '@mayhem93/nexxus-database-lib';
import { NexxusMessageQueuePublishException } from '@mayhem93/nexxus-message-queue-lib';

import { Request, Response, NextFunction } from 'express';

export default async (err: Error | NexxusApiException, _req: Request, res: Response, _next: NextFunction) : Promise<void> => {
  // What the client is told may be a generic stand-in; the log gets what happened.
  const original = err;

  if (!(err instanceof NexxusException)) {
    err = new ServerErrorException('An unexpected server error occurred.');
  }

  if (err instanceof FatalErrorException) {
    err = new ServerErrorException('A fatal server error occurred.');
  }

  // The database failed us: a plain 500, with its details kept to the log.
  if (err instanceof NexxusDatabaseException) {
    err = new ServerErrorException('An unexpected server error occurred.');
  }

  // The broker didn't confirm a write it was handed, so it may never be
  // applied: the client is told to retry.
  if (err instanceof NexxusMessageQueuePublishException) {
    err = new ServiceUnavailableException();
  }

  const statusCode = (err as NexxusApiException).statusCode || 500;

  if (statusCode >= 500) {
    NexxusApi.logger.error(`${original.message}\n${original.stack}`, { name: original.name, stack: original.stack }, 'NxxApi');
  } else {
    NexxusApi.logger.info(err.message, { name: err.name }, 'NxxApi');
  }

  const errorResponse = {
    error: err.name,
    message: err.message,
    ...(process.env.NODE_ENV === 'dev' ? { stack: original.stack } : {})
  };

  res.status(statusCode).json(errorResponse);
};
