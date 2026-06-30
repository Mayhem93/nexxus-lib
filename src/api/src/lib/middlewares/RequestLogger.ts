import { NexxusApiRequest, NexxusApi } from "../Api";

import { type NextFunction, type Response } from "express";

export default (req: NexxusApiRequest, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;

    NexxusApi.logger.info(
      `${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`,
      { method: req.method, url: req.originalUrl, statusCode: res.statusCode, duration },
      'NxxApi'
    );
  });

  next();
};
