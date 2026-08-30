import type { NexxusModelDef } from "./ModelTypes";

/**
 * Universal fields present in all models (auto-managed by NexxusBaseModel).
 * 'type' and 'appId' are excluded as they are handled separately in queries.
 */
export const NEXXUS_UNIVERSAL_FIELDS = {
  id:        { type: 'string', required: true, filterable: true },
  createdAt: { type: 'date',   required: true, filterable: true },
  updatedAt: { type: 'date',   required: true, filterable: true }
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
 * App-scoped built-in models — persisted per application in
 * `nxx-app-{appId}-{type}` indices, exactly like developer-declared app
 * models. Their names are RESERVED: an application schema cannot declare a
 * model of the same name (enforced in the `NexxusApplication` constructor
 * via `isAppScopedBuiltinModel`), since those names would collide with the
 * framework-managed per-app indices.
 */
export const NEXXUS_APP_SCOPED_MODEL_SCHEMAS = {
  user: {
    appId:         { type: 'string',  required: true,  filterable: true },
    userType:      { type: 'string',  required: true,  filterable: true },
    username:      { type: 'string',  required: true,  filterable: true },
    password:      { type: 'string',  required: true,  nullable: true },
    authProviders: { type: 'array',   required: true,  arrayType: 'string' },
    devices:       { type: 'array',   required: true,  arrayType: 'string' },
    details:       { type: 'object',  required: false, properties: {} },
  },
  /**
   * Per-application ACL role. One document per role; the document `id` is the
   * role name (no separate `name` field), and `statements` is always a JSON-
   * encoded string (see `NexxusAclRole`). `appId` mirrors `user` since roles
   * are app-scoped. Only `appId` is filterable — roles are otherwise looked
   * up by id.
   */
  acl: {
    appId:       { type: 'string', required: true,  filterable: true },
    description: { type: 'string', required: false },
    statements:  { type: 'string', required: true },
  },
} as const satisfies Record<string, NexxusModelDef>;

/**
 * Deployment-scoped built-in models — a single index per model
 * (`nxx-application`, `nxx-setting`), not partitioned by app.
 */
export const NEXXUS_DEPLOYMENT_MODEL_SCHEMAS = {
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
        jwtSecret:        { type: 'string', required: true },
        jwtExpiresIn:     { type: 'string', required: false },
        strategies:       { type: 'object', required: true,  properties: {} },
        userTypes:        { type: 'object', required: false, properties: {} },
        userDetailSchema: { type: 'object', required: false, properties: {} },
        acl: { type: 'boolean', required: false }
      },
    },
  },
  /**
   * Deployment-scoped setting. One document per setting; the document `id`
   * is the setting name, and `value` is always a JSON-encoded string
   * (see `NexxusSetting`). Not filterable — settings are looked up by id.
   */
  setting: {
    value: { type: 'string', required: true },
  }
} as const satisfies Record<string, NexxusModelDef>;

/**
 * All built-in (reserved) models — the runtime source of truth for built-in
 * model field shapes; the corresponding TS interfaces (INexxusUser,
 * INexxusApplication, INexxusAclRole, …) are derived from these.
 */
export const NEXXUS_BUILTIN_MODEL_SCHEMAS = {
  ...NEXXUS_DEPLOYMENT_MODEL_SCHEMAS,
  ...NEXXUS_APP_SCOPED_MODEL_SCHEMAS,
};

/**
 * Type helper to get valid built-in model types
 */
export type NexxusBuiltinModelType = keyof typeof NEXXUS_BUILTIN_MODEL_SCHEMAS;

/**
 * App-scoped built-in model types (`user`, `acl`) — the names an application
 * schema may not reuse for its own models.
 */
export type NexxusAppScopedModelType = keyof typeof NEXXUS_APP_SCOPED_MODEL_SCHEMAS;

/**
 * Helper to check if a model type is built-in
 */
export function isBuiltinModel(modelType: string): modelType is NexxusBuiltinModelType {
  return modelType in NEXXUS_BUILTIN_MODEL_SCHEMAS;
}

/**
 * Helper to check if a model type is an app-scoped built-in (`user`/`acl`) —
 * used to reject application schemas that try to redeclare these names.
 */
export function isAppScopedBuiltinModel(modelType: string): modelType is NexxusAppScopedModelType {
  return modelType in NEXXUS_APP_SCOPED_MODEL_SCHEMAS;
}
