import { NexxusApiRequest } from "../Api";
import { InvalidParametersException } from "../Exceptions";

import { type NextFunction, type Response } from "express";

/**
 * Middleware: require the request to identify a device, for routes that act on
 * one (`GET`/`PUT /device`, subscribe, unsubscribe).
 *
 * The device id comes from the verified token, never from a header, so
 * reaching here without one means the caller is holding a token that was
 * minted without a device — or no token at all, which an application without
 * authentication is allowed to do. Either way the answer is the same: register
 * a device and use the token that comes back.
 *
 * Wire it AFTER `AuthMiddleware`, which is what populates `req.deviceId`.
 */
export default (req: NexxusApiRequest, res: Response, next: NextFunction) => {
  if (!req.deviceId) {
    throw new InvalidParametersException(
      'This endpoint requires a registered device, but the request carries no device. ' +
      'Register a device (POST /device/register) and use the token it returns.'
    );
  }

  next();
};
