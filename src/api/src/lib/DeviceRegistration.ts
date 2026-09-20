import {
  NexxusApplication,
  NexxusJsonPatch,
  NexxusUser
} from '@mayhem93/nexxus-core-lib';
import { NexxusDevice, RedisKeyNotFoundException } from '@mayhem93/nexxus-redis';

import { NexxusApi } from './Api';

import { randomUUID } from 'node:crypto';

const LOG_LABEL = 'NxxApiDeviceRegistration';

/** Matches the fallback in `NexxusDevice`'s own constructor. */
const DEFAULT_DEVICE_NAME = 'Unnamed Device';

/**
 * What a client can tell us about the device it's calling from. Both fields are
 * hints, not assertions: `id` is whatever the client has in local storage, and
 * an id that doesn't resolve to a device it owns is simply ignored.
 */
export type NexxusDeviceHint = {
  id?: string;
  name?: string;
};

/**
 * The device behind `deviceId` if this caller may claim it, otherwise `null`.
 *
 * Ownership is two-tier for the same reason it is everywhere else: an
 * application always owns its devices, but a user only exists to compare
 * against when the application has authentication.
 */
async function findReusableDevice(
  app: NexxusApplication,
  appId: string,
  userId: string | undefined,
  deviceId: string
): Promise<NexxusDevice | null> {
  let device: NexxusDevice;

  try {
    device = await NexxusDevice.get(deviceId);
  } catch (e) {
    if (e instanceof RedisKeyNotFoundException) {
      return null;
    }

    throw e;
  }

  const data = device.getValue();

  if (data.appId !== appId) {
    return null;
  }

  if (app.hasAuthEnabled() && data.userId !== userId) {
    return null;
  }

  return device;
}

/**
 * Record the new device on the user document so `/device/list` can find it.
 *
 * Only reached when there IS a user — a device on an application without
 * authentication simply has no owner to be listed under.
 */
async function linkDeviceToUser(
  app: NexxusApplication,
  appId: string,
  userId: string,
  deviceId: string
): Promise<void> {
  const devicesPatch = new NexxusJsonPatch({
    op: 'append',
    path: [ 'devices' ],
    value: [ deviceId ],
    metadata: { appId, id: userId, type: 'user' }
  });
  const updatedAtPatch = new NexxusJsonPatch({
    op: 'replace',
    path: [ 'updatedAt' ],
    value: [ new Date().toISOString() ],
    metadata: { appId, id: userId, type: 'user' }
  });
  const userSchema = NexxusUser.getModelSchema(app.getUserDetailSchema());

  devicesPatch.validate(userSchema);
  updatedAtPatch.validate(userSchema);

  await NexxusApi.database.updateItems([ devicesPatch, updatedAtPatch ]);
}

async function createDevice(
  app: NexxusApplication,
  appId: string,
  userId: string | undefined,
  name?: string
): Promise<NexxusDevice> {
  const device = new NexxusDevice({
    id: randomUUID(),
    appId,
    userId,
    name: name || DEFAULT_DEVICE_NAME,
    subscriptions: []
  });

  await device.save();

  if (userId) {
    await linkDeviceToUser(app, appId, userId, device.getValue().id);
  }

  return device;
}

/**
 * Find or create the device a request is coming from, and return it.
 *
 * Called on every path that mints a token — registration, login, OAuth
 * callback, explicit device registration — so that a token always carries a
 * device, and so "which device is this?" stops being a header the client writes.
 *
 * The three cases:
 *
 *   - **No hint** — a fresh client. Create a device.
 *   - **Hint resolves to a device this caller owns** — reuse it and refresh
 *     `lastSeen`. This is what stops a new device record appearing every time a
 *     7-day token expires and the user signs in again.
 *   - **Hint resolves to nothing, or to someone else's device** — create a new
 *     one. A stale or wrong id is not an error: the client can't be expected to
 *     know the server forgot its device, and treating it as an attack would
 *     just lock out anyone with old local storage.
 *
 * Reinstalling a client loses the hint and therefore produces a new device.
 * That is intended — it's a new installation, i.e. a new session, exactly as it
 * appears in the device list of any consumer product.
 */
export async function resolveDevice(
  app: NexxusApplication,
  userId: string | undefined,
  hint: NexxusDeviceHint = {}
): Promise<NexxusDevice> {
  const appId = app.getData().id as string;

  if (typeof hint.id === 'string' && hint.id.length > 0) {
    const existing = await findReusableDevice(app, appId, userId, hint.id);

    if (existing) {
      await NexxusDevice.update(hint.id, { lastSeen: new Date() });

      return existing;
    }

    NexxusApi.logger.debug(
      `Device hint "${hint.id}" did not resolve to a device owned by this caller — issuing a new one`,
      { appId, userId },
      LOG_LABEL
    );
  }

  return createDevice(app, appId, userId, hint.name);
}
