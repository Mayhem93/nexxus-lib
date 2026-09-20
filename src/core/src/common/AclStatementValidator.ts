import {
  NexxusAclGrammar,
  ACL_CONDITION_OPERATORS,
  ACL_CONTEXT_KEYS,
  type NexxusAclStatement,
  type NexxusAclCondition,
  type NexxusAclConditionOperator,
} from './AclStatement';
import type { NexxusFieldDef, PrimitiveFieldDef } from './ModelTypes';

import type { NexxusApplication } from '../models/Application';

/**
 * Validates ACL statements — the single home for "is this a well-formed,
 * meaningful role?". Split into two passes because a role is constructed in two
 * contexts:
 *   - `validateStructure` — schema-free; runs at construction (works during DB
 *     hydration, where no app schema is available).
 *   - `validateAgainstSchema` — needs the owning app; run at role creation
 *     (CLI/Hub) and at boot (`loadAclRoles`) to reject/spot resources or
 *     condition fields that don't fit the app.
 *
 * It does not parse, compile, or evaluate — those belong to the model and the
 * engine respectively.
 */
export class NexxusAclStatementValidator {
  /** Fields a condition may reference without an explicit `acl` declaration —
   *  framework-managed and always present on every model. */
  private static readonly BUILTIN_CONDITION_FIELDS: ReadonlySet<string> =
    new Set(['id', 'userId', 'createdAt']);

  /** Schema-free structural validation of a role's statements. Throws on the
   *  first problem with a message naming the offending statement. */
  public static validateStructure(statements: unknown, roleName: string): void {
    if (!Array.isArray(statements)) {
      throw new Error(`ACL role "${roleName}": "statements" must be an array`);
    }

    statements.forEach((statement, index) => {
      NexxusAclStatementValidator.validateStatementStructure(statement, `ACL role "${roleName}" statement #${index}`);
    });
  }

  /** Schema-dependent validation: resources name real models and condition
   *  fields exist, are `acl:true` (or builtin), and are filterable. */
  public static validateAgainstSchema(
    statements: NexxusAclStatement[],
    app: NexxusApplication,
    roleName: string,
  ): void {
    statements.forEach((statement, index) => {
      NexxusAclStatementValidator.validateStatementAgainstSchema(
        statement, app, `ACL role "${roleName}" statement #${index}`
      );
    });
  }

  private static validateStatementStructure(statement: unknown, where: string): void {
    if (!statement || typeof statement !== 'object') {
      throw new Error(`${where}: must be an object`);
    }

    const raw = statement as Record<string, unknown>;

    if (raw.effect !== 'Allow' && raw.effect !== 'Deny') {
      throw new Error(`${where}: "effect" must be "Allow" or "Deny"`);
    }

    if (!Array.isArray(raw.action) || raw.action.length === 0) {
      throw new Error(`${where}: "action" must be a non-empty array`);
    }

    for (const action of raw.action) {
      if (typeof action !== 'string' || NexxusAclGrammar.expandActionToken(action) === null) {
        throw new Error(`${where}: unknown action "${String(action)}"`);
      }
    }

    if (!Array.isArray(raw.resource) || raw.resource.length === 0) {
      throw new Error(`${where}: "resource" must be a non-empty array`);
    }

    for (const resource of raw.resource) {
      if (typeof resource !== 'string' || resource.length === 0) {
        throw new Error(`${where}: "resource" entries must be non-empty strings`);
      }

      if (resource.includes(':')) {
        throw new Error(
          `${where}: field-level resource "${resource}" is not supported — model sensitive fields as a separate model`
        );
      }
    }

    // Conditions only scope Allow statements; a Deny is unconditional in v1.
    if (raw.condition !== undefined && raw.effect === 'Allow') {
      NexxusAclStatementValidator.validateConditionStructure(raw.condition, where);
    }
  }

  private static validateConditionStructure(condition: unknown, where: string): void {
    if (!condition || typeof condition !== 'object') {
      throw new Error(`${where}: "condition" must be an object`);
    }

    for (const [operator, block] of Object.entries(condition)) {
      if (!(ACL_CONDITION_OPERATORS as readonly string[]).includes(operator)) {
        throw new Error(`${where}: unknown condition operator "${operator}"`);
      }

      if (!block || typeof block !== 'object') {
        throw new Error(`${where}: condition "${operator}" must be an object`);
      }

      for (const [field, values] of Object.entries(block as Record<string, unknown>)) {
        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(`${where}: condition "${operator}.${field}" must be a non-empty array`);
        }

        for (const value of values) {
          if (NexxusAclGrammar.isContextRef(value)) {
            const key = NexxusAclGrammar.contextKeyOf(value);

            if (!(ACL_CONTEXT_KEYS as readonly string[]).includes(key)) {
              throw new Error(
                `${where}: unknown context key "${value}" ` +
                `(known: ${ACL_CONTEXT_KEYS.map(k => '$nxx:' + k).join(', ')})`
              );
            }
          } else if (typeof value !== 'string' && typeof value !== 'number') {
            throw new Error(`${where}: condition "${operator}.${field}" values must be strings or numbers`);
          }
        }
      }
    }
  }

  private static validateStatementAgainstSchema(statement: NexxusAclStatement, app: NexxusApplication, where: string): void {
    const appSchema = app.getSchema();
    const wildcardResource = statement.resource.includes('*');
    const concreteModels = statement.resource.filter(resource => resource !== '*');

    for (const model of concreteModels) {
      if (appSchema[model] === undefined) {
        throw new Error(`${where}: resource model "${model}" does not exist in the application schema`);
      }
    }

    if (!statement.condition) {
      return;
    }

    for (const field of NexxusAclStatementValidator.collectConditionFields(statement.condition)) {
      if (NexxusAclStatementValidator.BUILTIN_CONDITION_FIELDS.has(field)) {
        continue;
      }

      // A non-builtin field can't be checked against "all models" (`*`), and
      // wouldn't be guaranteed present everywhere anyway.
      if (wildcardResource) {
        throw new Error(
          `${where}: condition field "${field}" can't be used with a wildcard ("*") resource — ` +
          `only builtin fields (${[...NexxusAclStatementValidator.BUILTIN_CONDITION_FIELDS].join(', ')}) can`
        );
      }

      for (const model of concreteModels) {
        NexxusAclStatementValidator.assertConditionFieldUsable(app, model, field, where);
      }
    }
  }

  private static collectConditionFields(condition: NexxusAclCondition): Set<string> {
    const fields = new Set<string>();

    for (const operator of Object.keys(condition) as NexxusAclConditionOperator[]) {
      const block = condition[operator];

      if (block) {
        Object.keys(block).forEach(field => fields.add(field));
      }
    }

    return fields;
  }

  private static assertConditionFieldUsable(app: NexxusApplication, model: string, field: string, where: string): void {
    const def: NexxusFieldDef | undefined = app.getAppModelSchema(model)[field];

    if (!def) {
      throw new Error(`${where}: condition field "${field}" does not exist on model "${model}"`);
    }

    if (def.acl !== true) {
      throw new Error(`${where}: condition field "${field}" on model "${model}" must be declared "acl: true"`);
    }

    const isFilterablePrimitive =
      def.type !== 'object' && def.type !== 'array' && (def as PrimitiveFieldDef).filterable === true;

    if (!isFilterablePrimitive) {
      throw new Error(`${where}: condition field "${field}" on model "${model}" must be a filterable primitive`);
    }
  }
}
