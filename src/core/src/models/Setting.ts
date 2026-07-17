import {
  INexxusBaseModel,
  MODEL_REGISTRY
} from './BaseModel';
import { NexxusBuiltinModel } from './BuiltinModel';
import { NexxusModelDef } from '../common/ModelTypes';
import { InferModel } from '../common/InferModel';
import { NEXXUS_BUILTIN_MODEL_SCHEMAS } from '../common/BuiltinSchemas';

/**
 * Every known setting name. Serves as both the type source (via the derived
 * `NexxusSettingName` type below) and the runtime allow-list — the
 * `NexxusSetting` constructor rejects any `id` not in this array.
 *
 * Adding a new setting means adding a name here first. Callers that read
 * setting values (Hub admin routes, MQ bootstrapper, workers reading
 * pipeline config, …) get autocomplete and typo-safety for the names.
 */
export const NEXXUS_SETTING_NAMES = [
  'pipeline',
] as const;

/**
 * Type of every known setting name. Consumers can narrow on this instead of
 * carrying `string` around:
 *   `const name: NexxusSettingName = 'pipeline';`
 * A `string` that isn't in `NEXXUS_SETTING_NAMES` doesn't structurally match.
 */
export type NexxusSettingName = typeof NEXXUS_SETTING_NAMES[number];

export type INexxusSetting =
  & Omit<INexxusBaseModel<'setting'>, 'id'>
  & { id: NexxusSettingName }
  & InferModel<typeof NEXXUS_BUILTIN_MODEL_SCHEMAS.setting>;

/**
 * Deployment-scoped setting. One document per setting; the document `id` is
 * the setting name (no separate `name` field), and `value` is always a JSON-
 * encoded string. Consumers get parsed data via `getValue<T>()`; writers pass
 * `value` pre-stringified into the constructor. Updates go through the DB
 * adapter's `updateItems` with a JSON patch on `/value` — no setter on this
 * class, and no post-construction mutation of the value field is supported.
 */
export class NexxusSetting extends NexxusBuiltinModel<INexxusSetting> {
  constructor(data: INexxusSetting) {
    // `id` doubles as the setting name here, so it MUST be caller-supplied
    // AND be one of the registered names. Guard BEFORE super — otherwise
    // NexxusBaseModel would auto-generate a UUID and we'd silently lose the
    // "id is the name" contract.
    if (typeof data.id !== 'string' || data.id.length === 0) {
      throw new Error('NexxusSetting "id" is required and must be a non-empty string');
    }

    if (!NexxusSetting.isValidSettingName(data.id)) {
      throw new Error(`NexxusSetting invalid. Got "${data.id}".`);
    }

    if (typeof data.value !== 'string') {
      throw new Error(
        'NexxusSetting "value" must be a string — callers JSON.stringify ' +
        'non-string values before construction.'
      );
    }

    super({ ...data, type: MODEL_REGISTRY.setting });
  }

  public static getModelSchema(): NexxusModelDef {
    return { ...NEXXUS_BUILTIN_MODEL_SCHEMAS.setting };
  }

  /**
   * Type guard for setting names. Use at trust boundaries (Hub admin
   * HTTP routes, CLI arg parsing) to validate arbitrary strings before
   * passing them to the `NexxusSetting` constructor.
   */
  public static isValidSettingName(name: string): name is NexxusSettingName {
    return (NEXXUS_SETTING_NAMES as readonly string[]).includes(name);
  }

  /** The setting name (== the document id). */
  public getName(): NexxusSettingName {
    return this.data.id;
  }

  /** JSON-parse the stored value. Caller asserts the type they expect. */
  public getValue<T = unknown>(): T {
    return JSON.parse(this.data.value) as T;
  }
}
