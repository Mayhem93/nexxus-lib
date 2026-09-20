import {
  NexxusAclGrammar,
  type NexxusAclAction,
  type NexxusAclCondition,
  type NexxusAclContext,
  type NexxusAclStatement,
} from '../common/AclStatement';
import { NexxusAclConditionResolver } from './AclConditionResolver';

import type { NexxusAclRole } from '../models/AclRole';
import type { NexxusApplication } from '../models/Application';
import type { NexxusFilterQueryType } from '../common/FilterQuery';

/**
 * One role's verdict on an `(action, model)`:
 *   - `deny`    — a statement explicitly denies it (overrides any allow)
 *   - `allow`   — allowed; `constraint` is the row filter that must hold
 *                 (`null` = no row restriction)
 *   - `neutral` — no statement matched (contributes nothing)
 */
export type NexxusAclDecision = 'allow' | 'deny' | 'neutral';

type NexxusAclRoleVerdict =
  | { decision: 'deny' }
  | { decision: 'neutral' }
  | { decision: 'allow'; constraint: NexxusFilterQueryType | null };

/**
 * Aggregate outcome for a `(userType, action, model)` across a principal's
 * roles. `constraint` is present only when allowed AND row-restricted; a
 * `null` constraint means "allowed, no row restriction".
 */
export type NexxusAclResult =
  | { allowed: false }
  | { allowed: true; constraint: NexxusFilterQueryType | null };

/** A statement compiled once at construction for fast per-request evaluation. */
interface CompiledStatement {
  allow: boolean;
  actions: Set<NexxusAclAction>;
  allModels: boolean;
  models: Set<string>;
  condition?: NexxusAclCondition;
}

/**
 * The ACL decision engine for a single role. The API/worker builds one per
 * role loaded for an app and keys them by role name on the `NexxusApplication`.
 *
 * Statements arrive already validated (by `NexxusAclRole` / its validator), so
 * this class only COMPILES them into a fast lookup form and evaluates against
 * it. Condition→filter lowering is delegated to `NexxusAclConditionResolver`.
 * Cross-role aggregation is the static `resolve`.
 */
export class NexxusAclManager {
  private readonly role: NexxusAclRole;
  private readonly statements: CompiledStatement[];

  constructor(role: NexxusAclRole) {
    this.role = role;
    this.statements = role.getStatements().map(statement => NexxusAclManager.compile(statement));
  }

  /** The role this manager evaluates. */
  public getRole(): NexxusAclRole {
    return this.role;
  }

  /** The role name (== role id) this manager is bound to. */
  public getRoleName(): string {
    return this.role.getName();
  }

  /**
   * This role's verdict on an action against a model, in the given context.
   * A matching `Deny` wins outright (unconditional in v1). Otherwise matching
   * `Allow`s combine: an unconditional allow grants all rows; conditional
   * allows OR their row constraints. No match → neutral.
   */
  public evaluate(action: NexxusAclAction, model: string, ctx: NexxusAclContext): NexxusAclRoleVerdict {
    let unconditionalAllow = false;
    const constraints: NexxusFilterQueryType[] = [];

    for (const statement of this.statements) {
      if (!statement.actions.has(action)) {
        continue;
      }

      if (!statement.allModels && !statement.models.has(model)) {
        continue;
      }

      if (!statement.allow) {
        // Deny is an unconditional model+action block — wins immediately.
        return { decision: 'deny' };
      }

      if (!statement.condition) {
        unconditionalAllow = true;

        continue;
      }

      const filter = NexxusAclConditionResolver.resolve(statement.condition, ctx);

      // A null filter means the condition can't be satisfied in this context
      // (a referenced key is absent) — this allow simply doesn't apply.
      if (filter !== null) {
        constraints.push(filter);
      }
    }

    if (unconditionalAllow) {
      return { decision: 'allow', constraint: null };
    }

    if (constraints.length === 0) {
      return { decision: 'neutral' };
    }

    if (constraints.length === 1) {
      return { decision: 'allow', constraint: constraints[0] };
    }

    return { decision: 'allow', constraint: { $or: constraints } as NexxusFilterQueryType };
  }

  /**
   * Aggregate the roles granted to `userType` into a final decision for
   * `(action, model)`, AWS-style: an explicit `deny` from any role denies
   * outright; otherwise any `allow` grants (row constraints OR-ed across
   * roles); if every role is neutral, the default is DENY.
   */
  public static resolve(
    app: NexxusApplication,
    userType: string,
    action: NexxusAclAction,
    model: string,
    ctx: NexxusAclContext,
  ): NexxusAclResult {
    const roleNames = app.getUserTypes()?.[userType]?.roles ?? [];

    let sawAllow = false;
    let unconditional = false;
    const constraints: NexxusFilterQueryType[] = [];

    for (const name of roleNames) {
      const manager = app.getRoleManager(name);

      if (!manager) {
        continue;
      }

      const verdict = manager.evaluate(action, model, ctx);

      if (verdict.decision === 'deny') {
        return { allowed: false };
      }

      if (verdict.decision === 'allow') {
        sawAllow = true;

        if (verdict.constraint === null) {
          unconditional = true;
        } else {
          constraints.push(verdict.constraint);
        }
      }
    }

    if (!sawAllow) {
      return { allowed: false };
    }

    if (unconditional) {
      return { allowed: true, constraint: null };
    }

    if (constraints.length === 1) {
      return { allowed: true, constraint: constraints[0] };
    }

    return { allowed: true, constraint: { $or: constraints } as NexxusFilterQueryType };
  }

  /** Compile a validated statement into the per-request lookup form. Trusts the
   *  statement is well-formed (validated upstream by `NexxusAclRole`). */
  private static compile(statement: NexxusAclStatement): CompiledStatement {
    let allModels = false;
    const models = new Set<string>();

    for (const resource of statement.resource) {
      if (resource === '*') {
        allModels = true;
      } else {
        models.add(resource);
      }
    }

    return {
      allow: statement.effect === 'Allow',
      actions: NexxusAclGrammar.expandActions(statement.action),
      allModels,
      models,
      // Conditions only scope Allow statements; a Deny is unconditional.
      condition: statement.effect === 'Allow' ? statement.condition : undefined,
    };
  }
}
