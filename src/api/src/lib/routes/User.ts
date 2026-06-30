import { NexxusApiBaseRoute } from '../BaseRoute';
import {
  InvalidAuthMethodException,
  InvalidParametersException,
  ServerErrorException,
  UserAlreadyExistsException
} from '../Exceptions';
import {
  type NexxusApiRequest,
  type NexxusApiResponse,
  NexxusApi
} from '../Api';
import {
  RequiredHeadersMiddleware,
  AppExistsMiddleware,
  AuthMiddleware
} from '../middlewares';
import { NexxusAuthStrategy } from '../auth';

import {
  InvalidJsonPatchException,
  NexxusJsonPatch,
  NexxusJsonPatchInternal,
  NexxusUser,
} from '@mayhem93/nexxus-core-lib';

import type { Router, RequestHandler } from 'express';

type UserRegisterRequestBody = {
  username: string;
  password: string;
  userType?: string;
  [key: string]: any; // Additional user fields specified by app schema
};

type UserUpdateRequestBody = {
  patch: Omit<NexxusJsonPatchInternal, 'metadata'>;
}

interface UserRegisterRequest extends NexxusApiRequest {
  body: UserRegisterRequestBody;
}

interface UserUpdateRequest extends NexxusApiRequest {
  body: UserUpdateRequestBody;
}

export default class UserRoute extends NexxusApiBaseRoute {
  private static readonly forbiddenUpdatePaths = ['userType', 'authProviders', 'devices', 'createdAt', 'updatedAt'];

  constructor(appRouter: Router) {
    super('/user', appRouter);
  }

  protected registerRoutes(): void {
    this.router.use(RequiredHeadersMiddleware('nxx-app-id') as RequestHandler);
    this.router.use(AppExistsMiddleware() as RequestHandler);

    this.router.post('/register',
      this.register.bind(this) as RequestHandler
    );
    this.router.get('/me',
      AuthMiddleware as RequestHandler,
      this.me.bind(this) as RequestHandler
    );
    this.router.put('/',
      AuthMiddleware as RequestHandler,
      this.update.bind(this) as RequestHandler
    );
  }

  private async me(req: NexxusApiRequest, res: NexxusApiResponse): Promise<void> {
    const { iat, exp, aud, iss, ...userData } = req.user!;

    NexxusApi.logger.debug('Fetching current user data', { user: req.user! }, 'UserRoute');

    res.status(200).json(userData);
  }

  private async register(req: UserRegisterRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const { username, password, ...additionalFields } = req.body;

    // Validate required fields
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      throw new InvalidParametersException('Username and password are required');
    }

    // Look up THIS application's local strategy instance. The deployment-wide
    // `hasAuthStrategy('local')` check is no longer sufficient — the strategy
    // class might be registered but absent from this app's `auth.strategies`.
    const localStrategy = NexxusApi.instance.getAppAuthStrategy(appId, 'local');

    if (!localStrategy) {
      throw new InvalidAuthMethodException('Local authentication is not available for this application');
    }
    const existingUser = await localStrategy.findUserByUsername(appId, username);

    if (existingUser) {
      throw new UserAlreadyExistsException('User with this username already exists');
    }

    // Create new user
    const user = await localStrategy.createUser(appId, {
      username,
      userType: req.body.userType,
      password,
      authProviders: ['local'],
      details: additionalFields
    });

    res.status(200).json({
      message: 'User created successfully',
      user: {
        id: user.getData().id,
        username: user.getData().username
      }
    });
  }

  private async update(req: UserUpdateRequest, res: NexxusApiResponse): Promise<void> {
    if (req.body.patch === undefined || typeof req.body.patch !== 'object') {
      throw new InvalidParametersException('Invalid or missing patch data');
    }

    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId);
    const user = req.user!;

    if (app?.getUserDetailSchema(user.userType) === null) {
      throw new ServerErrorException('User details schema not found for user type');
    }

    const invalidPaths = req.body.patch.path.filter((path: string) => UserRoute.forbiddenUpdatePaths.includes(path));

    if (invalidPaths.length > 0) {
      throw new InvalidParametersException(`Invalid patch paths: "${invalidPaths.join(', ')}" cannot be updated`);
    }

    // find if password is being updated and add local auth strategy to array
    const passwordUpdateIndex = req.body.patch.path.findIndex(p => p === 'password');
    let authProvidersPatch: NexxusJsonPatch | undefined;

    if (passwordUpdateIndex !== -1) {
      req.body.patch.value[passwordUpdateIndex] = NexxusAuthStrategy.hashPassword(req.body.patch.value[passwordUpdateIndex]);

      if (!req.user!.authProviders.includes('local')) {
        authProvidersPatch = new NexxusJsonPatch({
          op: 'append',
          path: ['authProviders'],
          value: ['local'],
          metadata: {
            appId,
            id: req.user!.id,
            type: 'user'
          }
        });
      }
    }

    const patches = [];
    const jsonPatch = new NexxusJsonPatch({
      ...req.body.patch,
      metadata: {
        appId,
        id: req.user!.id,
        type: 'user'
      }
    });
    const updatedAtPatch = new NexxusJsonPatch({
      op: 'replace',
      path: ['updatedAt'],
      value: [ new Date() ],
      metadata: {
        appId,
        id: req.user!.id,
        type: 'user'
      }
    });

    patches.push(jsonPatch);
    patches.push(updatedAtPatch);

    try {
      const userSchema = NexxusUser.getModelSchema(app?.getUserDetailSchema(user.userType));

      if (authProvidersPatch) {
        authProvidersPatch.validate(userSchema);
        patches.push(authProvidersPatch);
      }

      jsonPatch.validate(userSchema);
      updatedAtPatch.validate(userSchema);

      await NexxusApi.database.updateItems(patches);

      res.status(200).json({ message: 'User updated successfully' });
    } catch (e) {
      if (e instanceof InvalidJsonPatchException) {
        throw new InvalidParametersException(`Invalid JSON Patch: ${e.message}`);
      }

      throw e;
    }
  }
}
