import { Request, Response, Router } from 'express';
import { NexxusApiBaseRoute } from '../BaseRoute';

export default class RootRoute extends NexxusApiBaseRoute {
  constructor(appRouter: Router) {
    super('/', appRouter);
  }

  protected registerRoutes(): void {
    // Not rate limited: answering costs less than counting, and a 429 here
    // would fail a load balancer's health check.
    this.router.get('/', (req: Request, res: Response) => {
      res.status(200).send({ message: 'Welcome to the Nexxus API!' });
    });
  }
}
