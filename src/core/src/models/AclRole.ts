import {
  INexxusBaseModel,
  MODEL_REGISTRY
} from './BaseModel';
import { NexxusBuiltinModel } from './BaseModel';
import { NexxusModelDef } from '../common/ModelTypes';
import { InferModel } from '../common/InferModel';
import { NEXXUS_BUILTIN_MODEL_SCHEMAS } from '../common/BuiltinSchemas';
import { NexxusAclStatementValidator } from '../common/AclStatementValidator';

import type { NexxusAclStatement } from '../common/AclStatement';
import type { NexxusApplication } from './Application';

export type INexxusAclRole =
  & Omit<INexxusBaseModel<'acl'>, 'id'>
  & { id: string }
  & InferModel<typeof NEXXUS_BUILTIN_MODEL_SCHEMAS.acl>;

/**
 * Id (== role name) of the framework-provided default role. Referenced by the
 * `default` user type, which the `NexxusApplication` constructor wires up
 * automatically when auth is enabled.
 */
export const DEFAULT_ACL_ROLE_ID = 'DefaultFullAccess';

/**
 * Framework-provided default role, granting full access. Always created
 * in-memory at boot (see the API/worker `loadAclRoles`) unless an app persists
 * its own `acl` document with this id, in which case the persisted role wins.
 * `appId` is filled in per app at load time. Stored (like every role) as a
 * JSON string.
 */
export const DEFAULT_ACL_ROLE = {
  id: DEFAULT_ACL_ROLE_ID,
  type: MODEL_REGISTRY.acl,
  description: 'Provides full access to all features of the application.',
  statements: JSON.stringify([{ effect: 'Allow', action: ['*'], resource: ['*'] }]),
} as const;

/**
 * Per-application ACL role. One document per role; the document `id` is the
 * role name (no separate `name` field, mirroring `NexxusSetting`).
 *
 * On the wire / in storage `statements` is a JSON-encoded string (see the
 * `acl` built-in schema). This class parses it ONCE at construction and holds
 * the resulting object array in memory — `getStatements()` returns that, while
 * `getData().statements` stays the original string for persistence. Validation
 * lives in `NexxusAclStatementValidator`: structural checks run here at
 * construction, and the schema-dependent checks are exposed via
 * `validateAgainstSchema` for callers that have the owning app (creation, boot).
 */
export class NexxusAclRole extends NexxusBuiltinModel<INexxusAclRole> {
  private readonly statements: NexxusAclStatement[];

  constructor(data: INexxusAclRole) {
    // `id` doubles as the role name here, so it MUST be caller-supplied.
    // Guard BEFORE super — otherwise NexxusBaseModel would auto-generate a
    // UUID and we'd silently lose the "id is the role name" contract.
    if (typeof data.id !== 'string' || data.id.length === 0) {
      throw new Error('NexxusAclRole "id" (role name) is required and must be a non-empty string');
    }

    if (typeof data.statements !== 'string') {
      throw new Error(`NexxusAclRole ("${data.id}") "statements" must be a JSON string`);
    }

    super({ ...data, type: MODEL_REGISTRY.acl });

    // Parse once and cache. Persisted form (`this.data.statements`) stays the
    // string so `getData()` round-trips straight back to the database.
    try {
      this.statements = JSON.parse(this.data.statements) as NexxusAclStatement[];
    } catch (err) {
      throw new Error(
        `NexxusAclRole ("${this.data.id}") "statements" must be a valid JSON string — failed to parse: ` +
        (err instanceof Error ? err.message : String(err)),
        { cause: err }
      );
    }

    NexxusAclStatementValidator.validateStructure(this.statements, this.data.id);
  }

  public static getModelSchema(): NexxusModelDef {
    return { ...NEXXUS_BUILTIN_MODEL_SCHEMAS.acl };
  }

  /** The role name (== the document id). */
  public getName(): string {
    return this.data.id;
  }

  /** The parsed statements (cached at construction). */
  public getStatements(): NexxusAclStatement[] {
    return this.statements;
  }

  /**
   * Schema-dependent validation against the owning app — resources name real
   * models and condition fields exist, are `acl:true`, and are filterable.
   * Called by role creation (CLI/Hub) and by the API/worker at boot.
   */
  public validateAgainstSchema(app: NexxusApplication): void {
    NexxusAclStatementValidator.validateAgainstSchema(this.statements, app, this.data.id);
  }
}
