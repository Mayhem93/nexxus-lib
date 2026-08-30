import {
  INexxusBaseModel,
  MODEL_REGISTRY
} from './BaseModel';
import { NexxusBuiltinModel } from './BaseModel';
import {
  NexxusFieldDef,
  NexxusModelDef
} from '../common/ModelTypes';
import { InferModel } from '../common/InferModel';
import {
  NEXXUS_BUILTIN_MODEL_SCHEMAS,
  NEXXUS_RESERVED_FIELD_NAMES,
  isAppScopedBuiltinModel
} from '../common/BuiltinSchemas';
import { NexxusUserDetailSchema } from './User';
import { DEFAULT_ACL_ROLE_ID } from './AclRole';

import type { NexxusAclManager } from '../lib/Acl';

import * as Dot from 'dot-prop';

/**
 * Per-app-model definition. Wraps the field defs with per-model flags:
 *   - `subscribable` (default true): whether the subscribe route accepts
 *     this model. `false` = traditional-DB shape — search works, all
 *     fields are treated as filterable, subscribe/unsubscribe 400.
 *   - `transient` (default false): create-only. `true` = update/delete
 *     routes 400. Meant for notification-shaped models where records are
 *     produced once and consumed via subscribe/search.
 *
 * The combination `subscribable: false && transient: true` is invalid —
 * a model that's create-only and can't be subscribed to has no useful
 * shape (the caller can't be notified of new records and can't mutate
 * existing ones). Rejected at construction.
 */
export interface NexxusApplicationModelDef {
  fields: NexxusModelDef;
  subscribable?: boolean;
  transient?: boolean;
}

export interface NexxusApplicationSchema {
  [modelName: string]: NexxusApplicationModelDef;
}

export interface NexxusUserTypeConfig {
  private?: boolean; // if true users can only be created through the nexxus hub API; defaults to false if not specified
  /**
   * ACL role names granted to users of this type. Each name must resolve to a
   * role loaded for the app (a persisted `acl` document or the framework
   * default). The constructor grants the `default` user type the framework
   * default role automatically.
   */
  roles?: string[];
}

/**
 * Per-application auth configuration. Lives on the Application document so
 * that each tenant carries its own JWT secret, per-strategy settings, and
 * user-shape declarations.
 *
 * `strategies` is a map keyed by strategy name (must be a subset of the
 * deployment's `api.auth.availableStrategies`). Each value's shape is
 * whatever the strategy's own JSON Schema defines — validated by the
 * corresponding `NexxusAuthStrategy` subclass at instantiation time.
 *
 * `userTypes` and `userDetailSchema` are per-user-type config maps that
 * only make sense in the presence of auth (no auth, no users). They live
 * under `auth` to express that dependency in the type.
 */
export interface NexxusApplicationAuthConfig {
  jwtSecret: string;
  jwtExpiresIn?: string;
  strategies: Record<string, unknown>;
  /**
   * Per-user-type config, keyed by user type name. When auth is enabled
   * the `NexxusApplication` constructor force-injects a `default` entry,
   * so any `hasAuthEnabled()` app is guaranteed at least
   * `userTypes.default`.
   */
  userTypes?: { [userType: string]: NexxusUserTypeConfig };
  /**
   * Per-user-type schema for the User `details` field. Required at
   * construction time when auth is enabled — the constructor throws if
   * absent — but may be an empty per-type map (`{}`) when the deployment
   * stores no extra user details.
   */
  userDetailSchema?: { [userType: string]: NexxusUserDetailSchema };
  /**
   * Deployment-wide ACL switch for this app. Defaults to false in the
   * constructor. When false, the field cache is never populated and ACL
   * checks are skipped — a guard so apps that don't use ACLs pay nothing.
   */
  acl?: boolean
}

export type INexxusApplication =
  & INexxusBaseModel<'application'>
  & InferModel<typeof NEXXUS_BUILTIN_MODEL_SCHEMAS.application>
  & {
    schema: NexxusApplicationSchema;
    auth?: NexxusApplicationAuthConfig;
    //defaults to 10 inside the class constructor
    defaultLimit?: number
    //defaults to 100 inside the class constructor. TODO: make this configurable in the Consumer config
    maxLimit?: number
  };

export class NexxusApplication extends NexxusBuiltinModel<INexxusApplication> {
  /**
   * ACL role managers for this app, keyed by role name. Populated at boot by
   * the API/worker after construction (roles are separate `acl` documents,
   * not part of the Application document). Empty until `setRoleManagers` runs.
   */
  private roleManagers: Map<string, NexxusAclManager> = new Map();

  constructor(data: INexxusApplication) {
    super({ ...data, type: MODEL_REGISTRY.application });

    if (Object.keys(data.schema).length === 0) {
      throw new Error('Application schema cannot be empty');
    }

    // Validate each per-model entry: `fields` presence + shape, per-model
    // flags, reserved-name check on declared fields, and the invalid flag
    // combo (subscribable=false + transient=true).
    for (const [modelName, modelDef] of Object.entries(data.schema)) {
      // App schemas may not redeclare an app-scoped built-in model name
      // (`user`, `acl`) — those names map to framework-managed per-app
      // indices (`nxx-app-{appId}-user` / `-acl`) and would collide.
      if (isAppScopedBuiltinModel(modelName)) {
        throw new Error(
          `Application schema: model "${modelName}" uses a reserved app-scoped built-in ` +
          `name and cannot be declared by an application`
        );
      }

      if (!modelDef || typeof modelDef !== 'object') {
        throw new Error(`Application schema: model "${modelName}" must be an object`);
      }

      if (!modelDef.fields || typeof modelDef.fields !== 'object') {
        throw new Error(`Application schema: model "${modelName}" must have a "fields" object`);
      }

      if (modelDef.subscribable !== undefined && typeof modelDef.subscribable !== 'boolean') {
        throw new Error(`Application schema: model "${modelName}" "subscribable" must be a boolean if provided`);
      }

      if (modelDef.transient !== undefined && typeof modelDef.transient !== 'boolean') {
        throw new Error(`Application schema: model "${modelName}" "transient" must be a boolean if provided`);
      }

      if (modelDef.subscribable === false && modelDef.transient === true) {
        throw new Error(
          `Application schema: model "${modelName}" cannot be both non-subscribable and transient — ` +
          `a create-only model that clients also can't subscribe to has no observable shape`
        );
      }

      modelDef.subscribable = modelDef.subscribable ?? true;
      modelDef.transient = modelDef.transient ?? false;

      // Reject any app-model schema that declares a field with a Nexxus-reserved
      // name. These names are managed by the system (id/createdAt/updatedAt by
      // BaseModel, type/appId/userId by the API/Worker, version by the database
      // adapter) and cannot be redefined by app developers.
      for (const fieldName of Object.keys(modelDef.fields)) {
        if (NEXXUS_RESERVED_FIELD_NAMES.has(fieldName)) {
          throw new Error(
            `Application schema: model "${modelName}" declares a field "${fieldName}", ` +
            `which is a Nexxus-reserved name. Reserved: ${[...NEXXUS_RESERVED_FIELD_NAMES].join(', ')}.`
          );
        }
      }
    }

    if (data.description !== undefined && typeof data.description !== 'string') {
      throw new Error('Application "description" must be a string if provided');
    }

    if (data.name === undefined || typeof data.name !== 'string') {
      throw new Error('Application "name" is required and must be a string');
    }

    if (data.defaultLimit !== undefined && (typeof data.defaultLimit !== 'number' || data.defaultLimit <= 10)) {
      throw new Error('Application "defaultLimit" must be a greater than 10 if provided');
    }

    // Assign resolved defaults onto `this.data` — `super()` already shallow-copied
    // `data` into `this.data`, so mutating `data` here would not persist to the
    // stored model (unlike the nested `schema` flags, which share a reference).
    this.data.defaultLimit = data.defaultLimit ?? 10;

    if (data.maxLimit !== undefined && (typeof data.maxLimit !== 'number' || data.maxLimit <= 0 || data.maxLimit < this.data.defaultLimit!)) {
      throw new Error('Application "maxLimit" must be a positive number if provided and must be greater than or equal to "defaultLimit"');
    }

    this.data.maxLimit = data.maxLimit ?? 100;

    if (data.auth) {
      // Per-app auth block. Per-strategy config shapes are NOT validated here —
      // each strategy's own JSON Schema handles that when the strategy is
      // instantiated by the API at init time. Here we only enforce that the
      // block itself is coherent: a usable JWT secret, at least one declared
      // strategy, and a user-detail schema map (possibly empty).
      if (typeof data.auth !== 'object') {
        throw new Error('Application "auth" must be an object when provided');
      }

      if (typeof data.auth.jwtSecret !== 'string' || data.auth.jwtSecret.length === 0) {
        throw new Error('Application "auth.jwtSecret" is required and must be a non-empty string when auth is enabled');
      }

      if (data.auth.jwtExpiresIn !== undefined && typeof data.auth.jwtExpiresIn !== 'string') {
        throw new Error('Application "auth.jwtExpiresIn" must be a string if provided');
      }

      if (
        !data.auth.strategies
        || typeof data.auth.strategies !== 'object'
        || Object.keys(data.auth.strategies).length === 0
      ) {
        throw new Error('Application "auth.strategies" must be a non-empty object when auth is enabled, ');
      }

      if (!data.auth.userDetailSchema || typeof data.auth.userDetailSchema !== 'object') {
        throw new Error('Application "auth.userDetailSchema" must be provided when auth is enabled');
      }

      if (data.auth.userTypes !== undefined && typeof data.auth.userTypes !== 'object') {
        throw new Error('Application "auth.userTypes" must be an object when provided');
      }

      if (data.auth.acl !== undefined && typeof data.auth.acl !== 'boolean') {
        throw new Error('Application "auth.acl" must be a boolean if provided');
      }

      data.auth.acl = data.auth.acl ?? false;

      // Rebuild auth with the default user type force-injected. Fresh object
      // so the caller's `data.auth` isn't mutated. `default` always wins
      // over an operator-supplied `default` key, matching the previous
      // behavior on the old top-level `userTypes` shape.
      this.data.auth = {
        ...data.auth,
        userTypes: data.auth.userTypes
          ? { ...data.auth.userTypes, default: { roles: [DEFAULT_ACL_ROLE_ID] } }
          : { default: { roles: [DEFAULT_ACL_ROLE_ID] } }
      };
    }

    //TODO: actually use json schema validation for schema structure
  }

  public getSchema(): NexxusApplicationSchema {
    return this.data.schema;
  }

  public getUserDetailSchema(userType: string = 'default'): NexxusUserDetailSchema | null {
    const userDetailSchema = this.data.auth?.userDetailSchema;

    if (!userDetailSchema) {
      return null;
    }

    return userDetailSchema[userType] ?? null;
  }

  /**
   * Per-user-type config map, or `null` when auth is disabled. The default
   * user type (`userTypes.default`) is guaranteed to exist when auth is
   * enabled — the constructor injects it.
   */
  public getUserTypes(): { [userType: string]: NexxusUserTypeConfig } | null {
    return this.data.auth?.userTypes ?? null;
  }

  public hasAuthEnabled(): boolean {
    return !!this.data.auth;
  }

  /**
   * Whether this app has ACLs enabled. When false, the Writer skips field-cache
   * maintenance and the API skips ACL checks.
   */
  public isAclEnabled(): boolean {
    return this.data.auth?.acl === true;
  }

  /**
   * Replace this app's ACL role managers. Called at boot by the API/worker
   * with one manager per role loaded for the app (the framework default plus
   * any persisted `acl` documents). Keyed by role name for lookup.
   */
  public setRoleManagers(managers: NexxusAclManager[]): void {
    this.roleManagers = new Map(managers.map(manager => [manager.getRoleName(), manager]));
  }

  /** The manager for a single role by name, or undefined if not loaded. */
  public getRoleManager(name: string): NexxusAclManager | undefined {
    return this.roleManagers.get(name);
  }

  /** All loaded role managers, keyed by role name. */
  public getRoleManagers(): Map<string, NexxusAclManager> {
    return this.roleManagers;
  }

  /**
   * Top-level field names in `modelType` flagged `acl: true` — the app-declared
   * fields the Writer mirrors into the Redis field cache (on top of the
   * always-cached builtin fields: id, userId, createdAt). Empty set for an
   * unknown model type. Nested acl flags are not resolved here (a later
   * extension); an object/array field flagged `acl` is cached whole.
   */
  public getAclFields(modelType: string): Set<string> {
    const appModelDef = this.data.schema[modelType];
    const aclFields = new Set<string>();

    if (!appModelDef) {
      return aclFields;
    }

    for (const [fieldName, fieldDef] of Object.entries(appModelDef.fields)) {
      if (fieldDef.acl === true) {
        aclFields.add(fieldName);
      }
    }

    return aclFields;
  }

  /**
   * Runtime field schema for one of the developer-declared models in this
   * application's `schema` field. Built-in models (user, application) have
   * their own static `getModelSchema` and are not resolved here.
   *
   * When the model is `subscribable: false`, every queryable field (primitives
   * and primitive-element arrays) is force-marked `filterable: true`
   * recursively — that's how the "traditional-DB, all-fields-filterable"
   * behaviour lands in downstream FilterQuery validation without those callers
   * needing to know about the flag.
   */
  public getAppModelSchema(modelType: string): NexxusModelDef {
    const appModelDef = this.data.schema[modelType];

    if (!appModelDef) {
      throw new Error(`Unknown app model type: ${modelType}`);
    }

    const fields = structuredClone(appModelDef.fields);

    if (this.hasAuthEnabled()) {
      fields.userId = { type: 'string', required: true, filterable: true };
    }

    if (appModelDef.subscribable === false) {
      NexxusApplication.markAllFilterable(fields);
    }

    return fields;
  }

  /**
   * Recursively force `filterable: true` on every queryable field def: every
   * primitive, and every primitive-element array (membership-queryable via
   * eq/ne/in). Object fields recurse into their properties; arrays of objects
   * are left alone (they can't be membership-queried). Mutates in place —
   * callers pass a clone.
   */
  private static markAllFilterable(fields: Record<string, NexxusFieldDef>): void {
    for (const def of Object.values(fields)) {
      if (def.type === 'object') {
        NexxusApplication.markAllFilterable(def.properties);
      } else if (def.type === 'array') {
        if (def.arrayType !== 'object') {
          def.filterable = true;
        }
      } else {
        def.filterable = true;
      }
    }
  }

  /**
   * Whether the given model type accepts subscribe/unsubscribe. Default:
   * true (existing behaviour when the flag is unspecified).
   */
  public isSubscribable(modelType: string): boolean {
    const appModelDef = this.data.schema[modelType];

    if (!appModelDef) {
      throw new Error(`Unknown app model type: ${modelType}`);
    }

    return appModelDef.subscribable !== false;
  }

  /**
   * Whether the given model type is create-only (update/delete routes
   * reject it). Default: false.
   */
  public isTransient(modelType: string): boolean {
    const appModelDef = this.data.schema[modelType];

    if (!appModelDef) {
      throw new Error(`Unknown app model type: ${modelType}`);
    }

    return appModelDef.transient === true;
  }

  /**
   * Runtime field schema for Application records. Static because the schema
   * is global — not per-app.
   */
  public static getModelSchema(): NexxusModelDef {
    return { ...NEXXUS_BUILTIN_MODEL_SCHEMAS.application };
  }

  public getAppModelFieldType(modelType: string, fieldPath: string): string | undefined {
    const appModelFieldType = Dot.getProperty(this.getSchema(), `${modelType}.fields.${fieldPath}.type`);

    return appModelFieldType as string | undefined;
  }

  public getModelFilterableFields(modelType: string): Set<string> {
    const modelDef = this.getSchema()[modelType];
    const filterableFields: Set<string> = new Set();

    if (!modelDef) {
      return filterableFields;
    }

    // Route through `getAppModelSchema` so we pick up the auto-marked
    // filterable fields on non-subscribable models (and the userId
    // injection when auth is enabled). The traversal below then only
    // needs to look at the `filterable` flag.
    const fields = this.getAppModelSchema(modelType);

    const collectFilterableFields = (
      subFields: Record<string, NexxusFieldDef>,
      prefix: string = ''
    ): void => {
      for (const [fieldName, fieldDef] of Object.entries(subFields)) {
        const fieldPath = prefix ? `${prefix}.${fieldName}` : fieldName;

        if (fieldDef.type === 'object') {
          collectFilterableFields(fieldDef.properties, fieldPath);
        } else if (fieldDef.filterable) {
          // Primitive or primitive-element array marked filterable. The array's
          // own path is collected (membership is matched against the whole
          // array), not traversed into.
          filterableFields.add(fieldPath);
        }
      }
    };

    collectFilterableFields(fields);

    return filterableFields;
  }
}
