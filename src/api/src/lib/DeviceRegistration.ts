import {
  NexxusApplication,
  NexxusJsonPatch,
  type NexxusJsonPatchRemoveValue,
  NexxusUser
} from '@mayhem93/nexxus-core-lib';
import { NexxusDevice, RedisKeyNotFoundException } from '@mayhem93/nexxus-redis';

import { NexxusApi } from './Api';

import { randomUUID } from 'node:crypto';

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
 * The devices sessions are issued to: building, creating and reusing them, and
 * keeping the device ids recorded on an account in step with the devices that
 * exist.
 */
export class NexxusApiDeviceRegistration {
  private static readonly LOG_LABEL = 'NxxApiDeviceRegistration';

  /** Matches the fallback in `NexxusDevice`'s own constructor. */
  private static readonly DEFAULT_DEVICE_NAME = 'Unnamed Device';

  /**
   * How long, in seconds, an account must go unwritten before
   * `unlinkMissingDevices` takes anything off it. A device's id is recorded on the
   * account before the device is saved, so on an account written moments ago an
   * id can name a device that is being saved right now.
   */
  private static readonly UNLINK_AFTER_SECONDS = 60;

  /**
   * A device with a fresh id, NOT saved.
   *
   * The account that owns a device is always written first and the device saved
   * after it, so a failure in between leaves an id on the account that names no
   * device — which `/device/list` skips, then removes (`unlinkMissingDevices`) —
   * rather than a device no account lists.
   *
   * Public for registration, which writes the id inline with the user it is
   * creating rather than appending it by patch afterwards, so it needs the id
   * before anything is stored.
   */
  public static buildDevice(
    appId: string,
    userId: string | undefined,
    name?: string
  ): NexxusDevice {
    return new NexxusDevice({
      id: randomUUID(),
      appId,
      userId,
      name: name || NexxusApiDeviceRegistration.DEFAULT_DEVICE_NAME,
      subscriptions: []
    });
  }

  /**
   * Create a device for an account that ALREADY EXISTS, and record it on that
   * account. This is the "another installation of an existing user" path —
   * `/device/register`, a login that finds no device to reuse, and a first OAuth
   * sign-in (where the user row was written by the verify step before we get here).
   *
   * The id is appended to the account first, then the device is saved (see
   * `buildDevice`). `null` when the account no longer exists; nothing is saved
   * then, and what that means is the caller's to say.
   *
   * Registration does not use this: it has no stored user to patch yet.
   */
  public static async createDeviceForUser(
    appId: string,
    userId: string | undefined,
    name?: string
  ): Promise<NexxusDevice | null> {
    const device = NexxusApiDeviceRegistration.buildDevice(appId, userId, name);

    if (userId) {
      const linked = await NexxusApiDeviceRegistration.patchUserDevices(appId, userId, 'append', [ device.getValue().id ]);

      if (!linked) {
        return null;
      }
    }

    await device.save();

    return device;
  }

  /**
   * Find or create the device a request is coming from, and return it.
   *
   * ONLY for an account that already exists — authenticating with `local`, a
   * returning OAuth user, or `/device/register`. A hint asks to reuse a device the
   * caller owns, and an account created moments ago owns none, so registration and
   * first OAuth sign-in call `buildDevice`/`createDeviceForUser` instead. Handing
   * this a brand-new user's id would spend a Redis lookup to conclude what the
   * caller already knew.
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
   *
   * `null` when a device had to be created for an account that no longer exists —
   * see `createDeviceForUser`.
   */
  public static async resolveDevice(
    app: NexxusApplication,
    userId: string | undefined,
    hint: NexxusDeviceHint = {}
  ): Promise<NexxusDevice | null> {
    const appId = app.getData().id as string;

    if (typeof hint.id === 'string' && hint.id.length > 0) {
      const existing = await NexxusApiDeviceRegistration.findReusableDevice(app, appId, userId, hint.id);

      if (existing) {
        await NexxusDevice.update(hint.id, { lastSeen: new Date() });

        return existing;
      }

      NexxusApi.logger.debug(
        `Device hint "${hint.id}" did not resolve to a device owned by this caller — issuing a new one`,
        { appId, userId },
        NexxusApiDeviceRegistration.LOG_LABEL
      );
    }

    return NexxusApiDeviceRegistration.createDeviceForUser(appId, userId, hint.name);
  }

  /**
   * Take off the user's account the ids among `deviceIds` that name no device —
   * what a device save that failed after its id was recorded leaves behind (see
   * `buildDevice`). Each id is checked with `NexxusDevice.exists` first, so one
   * that merely couldn't be read stays. Nothing is taken off an account written
   * to in the last minute (see `UNLINK_AFTER_SECONDS`).
   */
  public static async unlinkMissingDevices(user: NexxusUser, deviceIds: string[]): Promise<void> {
    const { id, appId, updatedAt } = user.getData();

    // Non-null: the model's constructor sets it.
    if (Math.floor(Date.now() / 1000) - updatedAt! < NexxusApiDeviceRegistration.UNLINK_AFTER_SECONDS) {
      return;
    }

    const existing = await NexxusDevice.exists(deviceIds);
    const missing = deviceIds.filter(deviceId => !existing.get(deviceId));

    if (missing.length === 0) {
      return;
    }

    // By value, so a device linked since `user` was read keeps its id.
    await NexxusApiDeviceRegistration.patchUserDevices(appId, id as string, 'remove', missing.map(deviceId => ({ v: deviceId })));

    NexxusApi.logger.info(
      `Removed ${missing.length} id(s) naming no device from user "${id}"`,
      { appId, userId: id, deviceIds: missing },
      NexxusApiDeviceRegistration.LOG_LABEL
    );
  }

  /**
   * The device behind `deviceId` if this caller may claim it, otherwise `null`.
   *
   * Ownership is two-tier for the same reason it is everywhere else: an
   * application always owns its devices, but a user only exists to compare
   * against when the application has authentication.
   */
  private static async findReusableDevice(
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
   * Change the device ids recorded on a user document, which `/device/list` reads:
   * `append` links a device, `remove` unlinks one, once per value. The document's
   * `updatedAt` moves along. `false` when the user no longer exists.
   *
   * Only reached when there IS a user — a device on an application without
   * authentication simply has no owner to be listed under.
   */
  private static async patchUserDevices(
    appId: string,
    userId: string,
    op: 'append' | 'remove',
    values: Array<string | NexxusJsonPatchRemoveValue>
  ): Promise<boolean> {
    const devicesPatch = new NexxusJsonPatch({
      op,
      path: values.map(() => 'devices'),
      value: values,
      metadata: { appId, id: userId, type: 'user' }
    });
    const updatedAtPatch = new NexxusJsonPatch({
      op: 'replace',
      path: [ 'updatedAt' ],
      value: [ new Date() ],
      metadata: { appId, id: userId, type: 'user' }
    });
    // No detail schema, deliberately. Both paths above are built-in user fields,
    // and this method is reached with a userId but no user type — the previous
    // `getUserDetailSchema()` silently meant "the DEFAULT type's schema", which is
    // the wrong one for every other type and `null` for an application that never
    // declares a `default` (nothing requires one). Passing nothing validates the
    // fields these patches actually touch and can't go stale.
    const userSchema = NexxusUser.getModelSchema();

    devicesPatch.validate(userSchema);
    updatedAtPatch.validate(userSchema);

    const patched = (await NexxusApi.database.updateItems([ devicesPatch, updatedAtPatch ])).get(userId);

    return Boolean(patched);
  }
}
