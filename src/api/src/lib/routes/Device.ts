import { NexxusApiBaseRoute } from '../BaseRoute';
import {
  type NexxusApiRequest,
  type NexxusApiResponse,
  NexxusApi
} from '../Api';
import {
  AppExistsMiddleware,
  AuthMiddleware,
  RequiredHeadersMiddleware,
  RequiresUserMiddleware,
  RequiresDeviceMiddleware
} from '../middlewares';
import { InvalidParametersException, NotFoundException } from '../Exceptions';
import { resolveDevice } from '../DeviceRegistration';

import { NexxusToken } from '@mayhem93/nexxus-core-lib';
import { NexxusDevice, NexxusDeviceProps, RedisKeyNotFoundException } from '@mayhem93/nexxus-redis';

import type { Router, RequestHandler } from 'express';

type RegisterDeviceRequestBody = Omit<NexxusDeviceProps, 'id' | 'appId' | 'status' | 'lastSeen' | 'subscriptions' | 'transport' | 'type'>;
type UpdateDeviceRequestBody = Pick<NexxusDeviceProps, 'name'>;

interface RegisterDeviceRequest extends NexxusApiRequest {
  body: RegisterDeviceRequestBody;
}

interface UpdateDeviceRequest extends NexxusApiRequest {
  body: UpdateDeviceRequestBody;
}

export default class DeviceRoute extends NexxusApiBaseRoute {
  constructor(appRouter: Router) {
    super('/device', appRouter);
  }

  protected registerRoutes(): void {
    // AppExists and Auth are router-level rather than per-route: only
    // `/register` used to carry AppExists, and because AuthMiddleware treats an
    // unresolvable app as "no auth configured", the other three ran completely
    // unauthenticated for any unknown `nxx-app-id`.
    this.router.use(RequiredHeadersMiddleware('nxx-app-id') as RequestHandler);
    this.router.use(AppExistsMiddleware() as RequestHandler);
    this.router.use(AuthMiddleware as RequestHandler);

    // No RequiresUser: an application without authentication has to be able to
    // register a device. The handler uses `req.user` only to record an owner
    // when there is one.
    this.router.post('/register', this.registerDevice.bind(this) as RequestHandler);
    this.router.get('/list',
      RequiresUserMiddleware as RequestHandler,
      this.listDevices.bind(this) as RequestHandler
    );
    // These act on "the calling device", which the token identifies. There is
    // no device parameter to pass — a caller can only ever address the device
    // its own token was issued to, which is what closes the cross-tenant
    // read/write hole the `nxx-device-id` header left open.
    this.router.get('/',
      RequiresDeviceMiddleware as RequestHandler,
      this.getDevice.bind(this) as RequestHandler
    );
    this.router.put('/',
      RequiresDeviceMiddleware as RequestHandler,
      this.updateDevice.bind(this) as RequestHandler
    );
  }

  private async registerDevice(req: RegisterDeviceRequest, res: NexxusApiResponse): Promise<void> {
    if (!req.body.name || typeof req.body.name !== 'string') {
      throw new InvalidParametersException('Invalid or missing device name in request body');
    }

    const appId = req.headers['nxx-app-id'] as string;
    // Non-null: AppExistsMiddleware is wired on this router.
    const app = NexxusApi.getStoredApp(appId)!;
    // Undefined on an application without authentication — the device is then
    // simply unowned.
    const userId = req.user?.id;
    // Same resolver the auth responses use, so creating a device and linking it
    // to its owner is defined once. No id hint here: this endpoint is the
    // explicit "register another device" path, so it always creates.
    const nxxDevice = await resolveDevice(app, userId, { name: req.body.name });

    // A token bound to the NEW device. Without it the caller has a device id it
    // can't use — every device-scoped route reads the device from the token, so
    // registering and receiving the credential have to be one step.
    const token = NexxusToken.issue(app, { appId, deviceId: nxxDevice.getValue().id, user: req.user });

    res.status(200).send({
      message: 'Device registered successfully!',
      token,
      device: {
        id: nxxDevice.getValue().id,
        appId: nxxDevice.getValue().appId,
        name: nxxDevice.getValue().name,
        userId: nxxDevice.getValue().userId,
      }
    });
  }

  private async getDevice(req: NexxusApiRequest, res: NexxusApiResponse): Promise<void> {
    // Non-null: RequiresDeviceMiddleware is wired on this route.
    const result = await this.loadCallingDevice(req.deviceId!);

    res.status(200).send(result.getValue());
  }

  private async listDevices(req: NexxusApiRequest, res: NexxusApiResponse): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    // Non-null: RequiresUserMiddleware is wired on this route.
    const userId = req.user!.id;

    const appUser = await NexxusApi.database.getItems({ ids: [ userId ], type: 'user', appId });
    const devices = appUser[0]?.getData().devices || [];
    // `allSettled`, not `all`: the id list lives on the user document while the
    // records themselves live in Redis, so the two drift — a reaped device
    // leaves an id behind. Failing the whole listing over one dangling id would
    // make a user's device list unreadable until someone pruned it by hand.
    const deviceResults = await Promise.allSettled(devices.map((deviceId: string) => NexxusDevice.get(deviceId)));
    const deviceData = deviceResults
      .filter((result): result is PromiseFulfilledResult<NexxusDevice> => result.status === 'fulfilled')
      .map(result => result.value.getValue());

    if (deviceData.length !== devices.length) {
      NexxusApi.logger.warn(
        `User "${userId}" lists ${devices.length} devices but only ${deviceData.length} could be read`,
        'DeviceRoute'
      );
    }

    res.status(200).send({ devices: deviceData });
  }

  /**
   * Load the device the caller's token was issued to.
   *
   * No ownership check: the id came from a token this application signed, so it
   * is already proof the caller owns the device. A miss means the record is
   * gone (reaped, or a stale token), which is a 404 rather than the 500 a raw
   * Redis exception would produce — those carry no status code.
   */
  private async loadCallingDevice(deviceId: string): Promise<NexxusDevice> {
    try {
      return await NexxusDevice.get(deviceId);
    } catch (e) {
      if (e instanceof RedisKeyNotFoundException) {
        throw new NotFoundException(`Device with id "${deviceId}" no longer exists`);
      }

      throw e;
    }
  }

  private async updateDevice(req: UpdateDeviceRequest, res: NexxusApiResponse): Promise<void> {
    // Non-null: RequiresDeviceMiddleware is wired on this route.
    const deviceId = req.deviceId!;

    if (!req.body.name || typeof req.body.name !== 'string') {
      throw new InvalidParametersException('Invalid or missing device name in request body');
    }

    await NexxusDevice.update(deviceId, { name: req.body.name });

    res.status(200).json({ message: 'Device updated successfully' });
  }
}
