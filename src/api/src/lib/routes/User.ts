import { NexxusApiBaseRoute } from '../BaseRoute';
import {
  InvalidAuthMethodException,
  InvalidParametersException,
  NotFoundException,
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
import { NexxusApiDeviceRegistration } from '../DeviceRegistration';

import {
  InvalidJsonPatchException,
  NexxusJsonPatch,
  NexxusJsonPatchInternal,
  NexxusUser,
  isReservedUserDetailField,
} from '@mayhem93/nexxus-core-lib';

import type { Router, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';

type UserRegisterRequestBody = {
  username: string;
  password: string;
  userType?: string;
  /**
   * No `device` here, deliberately. Registration always creates the account's
   * first device and takes no say in it: a hint asks to reuse something the
   * caller already owns, and wanting a device is the reason to register at all.
   * Only authenticating an existing account may hint. To rename the device
   * afterwards, `PUT /device`.
   */
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
  /**
   * `username` included: OAuth strategies find an account by its username (the
   * provider's email), so renaming one would cut it off from its provider — and
   * a rename couldn't be checked against the usernames already taken.
   */
  private static readonly forbiddenUpdatePaths = ['username', 'userType', 'authProviders', 'devices', 'createdAt', 'updatedAt'];

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
    // `userType` is pulled out alongside the credentials because it is a request
    // parameter, not a profile field — left in the rest it would ride into
    // `details` and be persisted as if it were part of someone's profile.
    //
    // `device` is NOT stripped any more, and that is the point: it is no longer a
    // parameter of this route, so it falls into `details` and the closed schema
    // rejects it like any other undeclared field. A client still sending one is
    // told so rather than having it silently swallowed.
    const { username, password, userType: _userType, ...details } = req.body;
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

    // Looked up and created under the username lock: a second registration, or
    // a first OAuth sign-in, for the same username at the same moment waits,
    // then finds this account instead of creating another.
    await localStrategy.withUsernameLock(username, async () => {
      const existingUser = await localStrategy.findUserByUsername(username);

      // Registering an existing account with its password signs in to it, so a
      // client retrying a registration whose response it never got — or one that
      // failed after the account was written — isn't locked out by its own first
      // attempt. The account as stored is what signs in: the user type and details
      // sent are ignored. Any other password, or an account with none (created
      // through an OAuth provider), means the username is taken.
      if (existingUser) {
        if (!await NexxusAuthStrategy.verifyPassword(password, existingUser.getData().password)) {
          throw new UserAlreadyExistsException('User with this username already exists');
        }

        await localStrategy.sendSessionForExistingUser(res, NexxusAuthStrategy.convertToApiUser(existingUser));

        return;
      }

      // The account's first device. Registering is how a client gets a device in
      // the first place, so this is not optional and takes no input — a brand-new
      // account has nothing to reuse and nothing to hint at.
      //
      // Built before the user, so its id is written into `devices` by the same
      // insert, and saved after it: the account is written first (see
      // `NexxusApiDeviceRegistration.buildDevice`), so a failed insert leaves
      // nothing behind.
      const userId = randomUUID();
      const device = NexxusApiDeviceRegistration.buildDevice(appId, userId);

      const user = await localStrategy.createUser({
        id: userId,
        deviceId: device.getValue().id,
        username,
        userType: req.body.userType,
        password,
        authProviders: ['local'],
        details
      });

      await device.save();

      // Finish like a login rather than making the client immediately turn around
      // and authenticate, so a freshly registered client is usable straight away.
      // The device is already decided, so this only issues its tokens and writes
      // the response — the id travels outward from here, and the client hints with
      // it when it later authenticates.
      await localStrategy.sendSession(res, NexxusAuthStrategy.convertToApiUser(user), device, { accountCreated: true });
    });
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
      // The value is hashed whole, so only `replace` makes sense: appending one
      // hash to another would leave a password nothing signs in with.
      if (patch.op !== 'replace' || typeof patch.value[passwordUpdateIndex] !== 'string' || !patch.value[passwordUpdateIndex]) {
        throw new InvalidParametersException('"password" can only be replaced, with a non-empty string');
      }

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

    // Constructed inside the `try`: the constructor rejects a malformed patch (an
    // unknown `op`, `path` and `value` of different lengths), and that is a 400.
    try {
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

      const userSchema = NexxusUser.getModelSchema(app.getUserDetailSchema(user.userType));

      if (authProvidersPatch) {
        authProvidersPatch.validate(userSchema);
        patches.push(authProvidersPatch);
      }

      jsonPatch.validate(userSchema);
      updatedAtPatch.validate(userSchema);

      const stored = (await NexxusApi.database.updateItems(patches)).get(user.id);

      // The token outlived the account.
      if (!stored) {
        throw new NotFoundException(`User "${user.id}" no longer exists`);
      }

      res.status(200).json({ message: 'User updated successfully' });
    } catch (e) {
      if (e instanceof InvalidJsonPatchException) {
        throw new InvalidParametersException(`Invalid JSON Patch: ${e.message}`);
      }

      throw e;
    }
  }
}
