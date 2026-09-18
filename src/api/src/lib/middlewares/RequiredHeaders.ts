import { NexxusApiRequest, NexxusApiHeaders } from '../Api';
import { InvalidParametersException } from '../Exceptions';

import type { NextFunction, Response } from 'express';

export default (header: keyof NexxusApiHeaders) => (req: NexxusApiRequest, res: Response, next: NextFunction) => {
  if (!req.headers[header]) {
    throw new InvalidParametersException(`Missing required header: ${header}`);
  }

  next();
};
