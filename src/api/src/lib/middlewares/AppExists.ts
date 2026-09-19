import { NexxusApiRequest, NexxusApi } from '../Api';
import { ApplicationNotFoundException } from '../Exceptions';

import { type NextFunction, type Response } from 'express';

export default () => (req: NexxusApiRequest, res: Response, next: NextFunction) => {
  const appId = req.headers['nxx-app-id'] as string;

  if (!NexxusApi.getStoredApp(appId)) {
    throw new ApplicationNotFoundException(`Application with ID "${appId}" not found.`);
  }

  next();
};
