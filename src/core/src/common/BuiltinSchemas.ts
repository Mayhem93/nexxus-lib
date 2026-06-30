import type { NexxusModelDef } from "./ModelTypes";

/**
 * Universal fields present in all models (auto-managed by NexxusBaseModel).
 * 'type' and 'appId' are excluded as they are handled separately in queries.
 */
export const NEXXUS_UNIVERSAL_FIELDS = {
  id:        { type: 'string', required: true },
  createdAt: { type: 'date',   required: true },
  updatedAt: { type: 'date',   required: true }
} as const satisfies NexxusModelDef;

/**
 * Field names reserved by Nexxus across ALL app models. App developers cannot
 * declare a field of these names in their application schemas — the
 * `NexxusApplication` constructor enforces this on schema registration.
 *
 * Most of these are caller-settable at model construction time (e.g. `appId`,
 * `userId`, `type` — set by the API/Worker). `version` is the sole exception:
 * it's set exclusively by the database adapter and rejected from user input
 * (see the inline check in `NexxusSchemaValidator.validateAgainstSchema`).
 */
export const NEXXUS_RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'appId',
  'userId',
  'type',
  'version'
]);

/**
 * Schema definitions for built-in (reserved) models. These are the runtime
 * source of truth for built-in model field shapes; the corresponding TS
 * interfaces (INexxusUser, INexxusApplication) are derived from these.
 */
export const NEXXUS_BUILTIN_MODEL_SCHEMAS = {
  user: {
    appId:         { type: 'string',  required: true,  filterable: true },
    userType:      { type: 'string',  required: true,  filterable: true },
    username:      { type: 'string',  required: true,  filterable: true },
    password:      { type: 'string',  required: true,  nullable: true },
    authProviders: { type: 'array',   required: true,  arrayType: 'string' },
    devices:       { type: 'array',   required: true,  arrayType: 'string' },
    details:       { type: 'object',  required: false, properties: {} },
  },
  application: {
    name:               { type: 'string',  required: true,  filterable: true },
    description:        { type: 'string',  required: false },
    /**
     * Per-application auth block. When `authEnabled` is true this must be
     * present and contain a non-empty `strategies` map; when false it should
     * be absent or have an empty `strategies`. The conditional rule isn't
     * expressible in the static schema — it's enforced imperatively in the
     * `NexxusApplication` constructor.
     *
     * `strategies` is a free-form map keyed by strategy name (e.g. 'local',
     * 'google'). The shape of each value is validated by that strategy's
     * own JSON Schema, loaded by the `NexxusAuthStrategy` base class.
     */
    auth: {
      type: 'object', required: false, nullable: true,
      properties: {
        jwtSecret:    { type: 'string', required: true },
        jwtExpiresIn: { type: 'string', required: false },
        strategies:   { type: 'object', required: true, properties: {} },
      },
    },
  }
} as const satisfies Record<string, NexxusModelDef>;

/**
 * Type helper to get valid built-in model types
 */
export type NexxusBuiltinModelType = keyof typeof NEXXUS_BUILTIN_MODEL_SCHEMAS;

/**
 * Helper to check if a model type is built-in
 */
export function isBuiltinModel(modelType: string): modelType is NexxusBuiltinModelType {
  return modelType in NEXXUS_BUILTIN_MODEL_SCHEMAS;
}
