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
  AuthMiddleware,
  RequiresUserMiddleware
} from '../middlewares';
import { NexxusAuthStrategy } from '../auth';
import { type NexxusDeviceHint } from '../DeviceRegistration';

import {
  InvalidJsonPatchException,
  NexxusJsonPatch,
  NexxusJsonPatchInternal,
  NexxusUser,
  isReservedUserDetailField,
} from '@mayhem93/nexxus-core-lib';

import type { Router, RequestHandler } from 'express';

type UserRegisterRequestBody = {
  username: string;
  password: string;
  userType?: string;
  /** Optional hint so a client with an existing device keeps it. */
  device?: NexxusDeviceHint;
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

  /**
   * Whether a patch path targets something the user may not write.
   *
   * Beyond the exact list above, anything under a reserved `details.$…` key is
   * off limits: those subtrees are written by auth strategies at login, and a
   * client that could edit `details.$auth_google.id` could repoint its account
   * at another person's provider identity. Prefix-matched rather than
   * enumerated so a strategy added later is covered without touching this.
   */
  private static isForbiddenUpdatePath(path: string): boolean {
    if (UserRoute.forbiddenUpdatePaths.includes(path)) {
      return true;
    }

    const [ root, detailField ] = path.split('.');

    return root === 'details' && detailField !== undefined && isReservedUserDetailField(detailField);
  }

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
      RequiresUserMiddleware as RequestHandler,
      this.me.bind(this) as RequestHandler
    );
    this.router.put('/',
      AuthMiddleware as RequestHandler,
      RequiresUserMiddleware as RequestHandler,
      this.update.bind(this) as RequestHandler
    );
  }

  private async me(req: NexxusApiRequest, res: NexxusApiResponse): Promise<void> {
    // The registered claims (iat/exp/aud/iss) sit on the token, not inside its
    // `user` claim, so there is nothing to strip out here.
    NexxusApi.logger.debug('Fetching current user data', { user: req.user }, 'UserRoute');

    res.status(200).json(req.user);
  }

  private async register(req: UserRegisterRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    // `userType` and `device` are pulled out alongside the credentials because
    // they are request parameters, not profile fields — left in the rest they'd
    // ride into `details` and be persisted on the user document (a device
    // registration hint stored as if it were part of someone's profile).
    const { username, password, userType: _userType, device: _device, ...details } = req.body;
    // Non-null: AppExistsMiddleware is wired on this router.
    const app = NexxusApi.getStoredApp(appId)!;

    // Not covered by RequiresUserMiddleware — this route CREATES the user, so
    // it runs without one. It still only makes sense on an app with auth.
    if (!app.hasAuthEnabled()) {
      throw new InvalidAuthMethodException('Authentication is not enabled for this application');
    }

    const userType = req.body.userType || 'default';

    if (!app.getUserTypes()?.[userType]) {
      throw new InvalidParametersException(`Invalid user type "${userType}"`);
    }

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
    const existingUser = await localStrategy.findUserByUsername(username);

    if (existingUser) {
      throw new UserAlreadyExistsException('User with this username already exists');
    }

    // Create new user
    const user = await localStrategy.createUser({
      username,
      userType: req.body.userType,
      password,
      authProviders: ['local'],
      details
    });

    // Finish like a login rather than making the client immediately turn around
    // and authenticate: this resolves the calling device and hands back a token
    // bound to it, so a freshly registered client is usable straight away.
    await localStrategy.sendTokenResponse(
      res,
      NexxusAuthStrategy.convertToApiUser(user),
      req.body.device
    );
  }

  private async update(req: UserUpdateRequest, res: NexxusApiResponse): Promise<void> {
    const patch = req.body.patch;

    // `path` and `value` are read here, before the NexxusJsonPatch constructor
    // gets a chance to validate them, so this route has to check them itself —
    // `{"patch":{}}` used to reach `patch.path.filter` and surface as a 500.
    if (!patch || typeof patch !== 'object' || !Array.isArray(patch.path) || !Array.isArray(patch.value)) {
      throw new InvalidParametersException('Invalid or missing patch data');
    }

    const appId = req.headers['nxx-app-id'] as string;
    // Non-null: AppExistsMiddleware is wired on this router.
    const app = NexxusApi.getStoredApp(appId)!;
    const user = req.user!;

    if (app.getUserDetailSchema(user.userType) === null) {
      throw new ServerErrorException('User details schema not found for user type');
    }

    const invalidPaths = patch.path.filter((path: string) => UserRoute.isForbiddenUpdatePath(path));

    if (invalidPaths.length > 0) {
      throw new InvalidParametersException(`Invalid patch paths: "${invalidPaths.join(', ')}" cannot be updated`);
    }

    // find if password is being updated and add local auth strategy to array
    const passwordUpdateIndex = req.body.patch.path.findIndex(p => p === 'password');
    let authProvidersPatch: NexxusJsonPatch | undefined;

    if (passwordUpdateIndex !== -1) {
      patch.value[passwordUpdateIndex] = await NexxusAuthStrategy.hashPassword(patch.value[passwordUpdateIndex]);

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
      const userSchema = NexxusUser.getModelSchema(app.getUserDetailSchema(user.userType));

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
