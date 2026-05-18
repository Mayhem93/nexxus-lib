import { NexxusApiBaseRoute } from '../BaseRoute';
import {
  type NexxusApiRequest,
  type NexxusApiResponse,
  NexxusApi
} from '../Api';
import { AppExistsMiddleware, AuthMiddleware, RequiredHeadersMiddleware } from '../middlewares';
import { InvalidParametersException, NotFoundException } from '../Exceptions';

import { NexxusDevice, NexxusDeviceProps } from '@mayhem93/nexxus-redis';
import { NexxusJsonPatch, NexxusUser } from '@mayhem93/nexxus-core-lib';

import type { Router, RequestHandler } from 'express';

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

type RegisterDeviceRequestBody = Omit<NexxusDeviceProps, 'id' | 'appId' | 'status' | 'lastSeen' | 'subscriptions' | 'connectedTo' | 'type'>;
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
    this.router.use(RequiredHeadersMiddleware('nxx-app-id') as RequestHandler);

    this.router.post('/register',
      AppExistsMiddleware() as RequestHandler,
      AuthMiddleware as RequestHandler,
      this.registerDevice.bind(this) as RequestHandler
    );
    this.router.get('/',
      RequiredHeadersMiddleware('nxx-device-id') as RequestHandler,
      AuthMiddleware as RequestHandler,
      this.getDevice.bind(this) as RequestHandler
    );
    this.router.get('/list',
      AuthMiddleware as RequestHandler,
      this.listDevices.bind(this) as RequestHandler
    );
    this.router.put('/',
      RequiredHeadersMiddleware('nxx-device-id') as RequestHandler,
      AuthMiddleware as RequestHandler,
      this.updateDevice.bind(this) as RequestHandler
    );
  }

  private async registerDevice(req: RegisterDeviceRequest, res: NexxusApiResponse): Promise<void> {
    if (!req.body.name || typeof req.body.name !== 'string') {
      throw new InvalidParametersException('Invalid or missing device name in request body');
    }

    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId);
    const userId = req.user?.id;
    const nxxDevice = new NexxusDevice({
      id: randomUUID(),
      appId: req.headers['nxx-app-id'] as string,
      userId: userId || null,
      name: req.body.name,
      status: 'offline',
      lastSeen: (new Date(0)).toDateString(),
      subscriptions: []
    });

    await nxxDevice.save();

    if (app?.hasAuthEnabled()) {
      const updateUserDevicesPatch = new NexxusJsonPatch({
        op: 'append',
        value: [nxxDevice.getValue().id],
        path: ['devices'],
        metadata: {
          appId: nxxDevice.getValue().appId,
          id: userId!,
          type: 'user'
        }
      });

      const updatedAtPatch = new NexxusJsonPatch({
        op: 'replace',
        value: [new Date().toISOString()],
        path: ['updatedAt'],
        metadata: {
          appId: nxxDevice.getValue().appId,
          id: userId!,
          type: 'user'
        }
      });

      const userSchema = NexxusUser.getModelSchema(app.getUserDetailSchema());

      updateUserDevicesPatch.validate(userSchema);
      updatedAtPatch.validate(userSchema);

      await NexxusApi.database.updateItems([updateUserDevicesPatch, updatedAtPatch]);
    }

    res.status(200).send({
      message: 'Device registered successfully!',
      device: {
        id: nxxDevice.getValue().id,
        appId: nxxDevice.getValue().appId,
        name: nxxDevice.getValue().name,
        userId: nxxDevice.getValue().userId,
      }
    });
  }

  private async getDevice(req: NexxusApiRequest, res: NexxusApiResponse): Promise<void> {
    const result = await NexxusDevice.get(req.headers['nxx-device-id'] as string);

    res.status(200).send(result.getValue());
  }

  private async listDevices(req: NexxusApiRequest, res: NexxusApiResponse): Promise<void> {
    const userId = req.user!.id;
    const appId = req.headers['nxx-app-id'] as string;

    const appUser = await NexxusApi.database.getItems({ ids: [ userId ], type: 'user', appId });
    const devices = appUser[0]?.getData().devices || [];
    const getDevicePromises = devices.map((deviceId: string) => NexxusDevice.get(deviceId));
    const deviceResults = await Promise.all(getDevicePromises);
    const deviceData = deviceResults.map(device => device.getValue());

    res.status(200).send({ devices: deviceData });
  }

  private async updateDevice(req: UpdateDeviceRequest, res: NexxusApiResponse): Promise<void> {
    const deviceId = req.headers['nxx-device-id'] as string;

    if (!req.body.name || typeof req.body.name !== 'string') {
      throw new InvalidParametersException('Invalid or missing device name in request body');
    }

    await NexxusDevice.update(deviceId, { name: req.body.name });

    res.status(200).json({ message: 'Device updated successfully' });
  }
}
