import {
  INexxusBaseModel,
  MODEL_REGISTRY
} from "./BaseModel";
import { NexxusBuiltinModel } from "./BaseModel";
import { NexxusFieldDef, NexxusModelDef } from "../common/ModelTypes";
import { InferModel } from "../common/InferModel";
import { NEXXUS_BUILTIN_MODEL_SCHEMAS } from "../common/BuiltinSchemas";
import { InvalidUserModelException } from "../lib/Exceptions";

export interface NexxusUserDetailSchema {
  [field: string]: NexxusFieldDef;
}

/**
 * Prefix reserved by Nexxus inside a user's `details` — and only there; model
 * schemas elsewhere have their own reserved names (`NEXXUS_RESERVED_FIELD_NAMES`)
 * and are unaffected by this.
 *
 * A `details` field starting with `$` is system-owned: written by Nexxus, never
 * declared in an application's `auth.userDetailSchema` and never settable from
 * user input. Reserving the prefix rather than individual names means a new
 * system-owned detail can be introduced later without colliding with a field
 * some application has already shipped.
 */
export const NEXXUS_USER_DETAIL_RESERVED_PREFIX = '$';

/** Whether a `details` field is system-owned rather than developer-declared. */
export const isReservedUserDetailField = (field: string): boolean =>
  field.startsWith(NEXXUS_USER_DETAIL_RESERVED_PREFIX);

/**
 * The `details` key one auth strategy's own fields live under: `$auth_google`,
 * `$auth_github`.
 *
 * Provider data can't share a flat namespace with developer-declared profile
 * fields — two strategies would eventually both want `name` — and it must not
 * be user-writable, since a client able to edit `$auth_google.id` could repoint
 * the account at someone else's provider identity.
 *
 * Underscore rather than a dot after `$auth`: patch paths are dot-separated, so
 * a literal dot inside a key would make the field unaddressable by
 * `NexxusJsonPatch`.
 */
export const authDetailKey = (strategyName: string): string => `$auth_${strategyName}`;

export type INexxusUser =
  & INexxusBaseModel<'user'>
  & InferModel<typeof NEXXUS_BUILTIN_MODEL_SCHEMAS.user>
  & { details?: Record<string, any> };

export class NexxusUser extends NexxusBuiltinModel<INexxusUser> {
  /**
   * Runtime field schema for User records. Optionally overlays a per-userType
   * detail schema (resolved from the owning application) into `details.properties`.
   */
  public static getModelSchema(userDetails?: NexxusUserDetailSchema | null): NexxusModelDef {
    const base: NexxusModelDef = { ...NEXXUS_BUILTIN_MODEL_SCHEMAS.user };

    if (userDetails) {
      base.details = { type: 'object', required: false, properties: userDetails };
    }

    return base;
  }

  constructor(data: INexxusUser) {
    super({ ...data, type: MODEL_REGISTRY.user });

    if (this.data.appId === undefined || typeof this.data.appId !== 'string') {
      throw new InvalidUserModelException("User 'appId' is required and must be a string");
    }

    if (this.data.username === undefined || typeof this.data.username !== 'string') {
      throw new InvalidUserModelException("User 'username' is required and must be a string");
    }

    if ((this.data.password !== undefined && this.data.password !== null) && typeof this.data.password !== 'string') {
      throw new InvalidUserModelException("User 'password' must be a string if provided");
    }

    if (this.data.authProviders === undefined || !Array.isArray(this.data.authProviders) || this.data.authProviders.some(ap => typeof ap !== 'string')) {
      throw new InvalidUserModelException("User 'authProviders' is required and must be an array of strings");
    }

    if (this.data.devices === undefined || !Array.isArray(this.data.devices)) {
      throw new InvalidUserModelException("User 'devices' must be an array of strings");
    } else {
      const areAllStrings = this.data.devices.every(deviceId => typeof deviceId === 'string');

      if (!areAllStrings) {
        throw new InvalidUserModelException("User 'devices' must be an array of strings");
      }
    }

    if (typeof this.data.userType !== 'string') {
      throw new InvalidUserModelException("User 'userType' must be a string");
    }

    if (this.data.details !== undefined && typeof this.data.details !== 'object') {
      throw new InvalidUserModelException("User 'details' must be an object if provided");
    }
  }
}
