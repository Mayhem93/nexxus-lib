import { NotFoundException } from '../Exceptions';

import { NextFunction, Request, Response } from 'express';

export default (req: Request, res: Response, next: NextFunction) => {
  throw new NotFoundException('Not Found');
};
