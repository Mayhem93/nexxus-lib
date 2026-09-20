import { NexxusApiException, ServerErrorException } from '../Exceptions';
import { NexxusApi } from '../Api';
import { FatalErrorException, NexxusException } from '@mayhem93/nexxus-core-lib';

import { Request, Response, NextFunction } from 'express';

export default async (err: Error | NexxusApiException, _req: Request, res: Response, _next: NextFunction) : Promise<void> => {
  if (!(err instanceof NexxusException)) {
    err = new ServerErrorException('An unexpected server error occurred.');
  }

  if (err instanceof FatalErrorException) {
    err = new ServerErrorException('A fatal server error occurred.');
  }

  const statusCode = (err as NexxusApiException).statusCode || 500;

  if (statusCode >= 500) {
    NexxusApi.logger.error(`${err.message}\n${err.stack}`, { name: err.name, stack: err.stack }, 'NxxApi');
  } else {
    NexxusApi.logger.info(err.message, { name: err.name }, 'NxxApi');
  }

  const errorResponse = {
    error: err.name,
    message: err.message,
    ...(process.env.NODE_ENV === 'dev' ? { stack: err.stack } : {})
  };

  res.status(statusCode).json(errorResponse);
};
