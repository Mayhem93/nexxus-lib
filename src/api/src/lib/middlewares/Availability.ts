import { ServiceUnavailableException } from '../Exceptions';

import { NextFunction, Request, Response } from 'express';

/**
 * Factory-shaped middleware that gates every incoming request on the API's
 * upstream-service availability. Takes a getter (not the boolean itself)
 * so the middleware always reads the latest state at request time, not the
 * state at wiring time.
 *
 * On !available the middleware doesn't respond directly — it hands a
 * `ServiceUnavailableException` to the error middleware via `next(err)`.
 * That routes the response through the same shape as every other
 * exception (JSON body, appropriate statusCode, sanitized message). No
 * details about WHICH upstream is down leak to the client.
 */
export default (isAvailable: () => boolean) => (req: Request, res: Response, next: NextFunction) => {
  if (!isAvailable()) {
    return next(new ServiceUnavailableException());
  }

  return next();
};
