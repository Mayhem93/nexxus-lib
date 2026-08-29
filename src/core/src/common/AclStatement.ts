/**
 * The ACL statement language: the shapes an `acl` role document is written in,
 * plus the grammar constants and the (pure) action-token expansion on
 * `NexxusAclGrammar`. This unit only DEFINES the language — it doesn't validate
 * meaning, compile, or evaluate. The validator, the model, and the engine all
 * build on it, and it depends on nothing ACL-related (a leaf), so those three
 * stay free of import cycles.
 */

export type NexxusAclEffect = 'Allow' | 'Deny';

/** The concrete, model-level operations. `subscribe` also governs unsubscribe. */
export const ACL_ACTIONS = ['create', 'get', 'search', 'count', 'update', 'delete', 'subscribe'] as const;
export type NexxusAclAction = typeof ACL_ACTIONS[number];

/** Sugar tokens expanding to a set of concrete actions. */
const READ_ACTIONS: readonly NexxusAclAction[] = ['get', 'search', 'count', 'subscribe'];
const WRITE_ACTIONS: readonly NexxusAclAction[] = ['create', 'update', 'delete'];

/** Supported condition operators. String vs Numeric documents the intended
 *  value type; both lower to equality / not-equality in the query DSL. */
export const ACL_CONDITION_OPERATORS =
  ['StringEquals', 'StringNotEquals', 'NumericEquals', 'NumericNotEquals'] as const;
export type NexxusAclConditionOperator = typeof ACL_CONDITION_OPERATORS[number];

/** Prefix marking a condition value as a context-key reference (vs a literal). */
export const ACL_CONTEXT_PREFIX = '$nxx:';

/** Context keys a `$nxx:<key>` reference can resolve to. */
export const ACL_CONTEXT_KEYS = ['userId', 'userType', 'appId'] as const;
export type NexxusAclContextKey = typeof ACL_CONTEXT_KEYS[number];

/**
 * One operator block: maps a MODEL FIELD to an array of allowed values (OR
 * within the array). Each value is either a literal or a context-key reference
 * like `$nxx:userId`, resolved from the request context at evaluation time.
 */
export type NexxusAclConditionBlock = Record<string, Array<string | number>>;

/**
 * A statement condition. Multiple operator blocks are AND-ed; within a block
 * multiple fields are AND-ed; within a field multiple values are OR-ed. Only
 * meaningful on `Allow` statements (a `Deny` is unconditional in v1).
 */
export type NexxusAclCondition = Partial<Record<NexxusAclConditionOperator, NexxusAclConditionBlock>>;

/**
 * A single ACL statement (AWS-IAM-flavoured). `action` values are the
 * `NexxusAclAction` literals plus the `read`/`write`/`*` sugar; `resource`
 * values are model names (or `*`). Field-level resources (`model:field`) are
 * NOT supported — model sensitive fields as their own model instead.
 */
export interface NexxusAclStatement {
  effect: NexxusAclEffect;
  action: string[];
  resource: string[];
  condition?: NexxusAclCondition;
}

/**
 * Neutral principal/context a decision is made against. Built by whichever
 * process is asking — the API from `req.user`, a worker from its payload — so
 * the engine never depends on transport types. These are the values `$nxx:*`
 * references resolve to.
 */
export interface NexxusAclContext {
  userId?: string;
  userType?: string;
  appId?: string;
}

/** Pure grammar operations over the statement language. Stateless statics. */
export class NexxusAclGrammar {
  /**
   * Expand one action token to the concrete actions it denotes, or `null` if
   * the token is neither a sugar word nor a known action. The validator uses
   * the `null` to flag bad tokens; the engine only ever passes valid ones.
   */
  public static expandActionToken(token: string): readonly NexxusAclAction[] | null {
    switch (token) {
      case '*':     return ACL_ACTIONS;
      case 'read':  return READ_ACTIONS;
      case 'write': return WRITE_ACTIONS;
      default:
        return (ACL_ACTIONS as readonly string[]).includes(token) ? [token as NexxusAclAction] : null;
    }
  }

  /** Expand a list of (already-valid) action tokens into a set. Unknown tokens
   *  are skipped — validation is the validator's job, not this method's. */
  public static expandActions(tokens: string[]): Set<NexxusAclAction> {
    const actions = new Set<NexxusAclAction>();

    for (const token of tokens) {
      const expanded = NexxusAclGrammar.expandActionToken(token);

      if (expanded) {
        expanded.forEach(action => actions.add(action));
      }
    }

    return actions;
  }

  /** Whether a condition value is a `$nxx:<key>` reference (vs a literal). */
  public static isContextRef(value: string | number): value is string {
    return typeof value === 'string' && value.startsWith(ACL_CONTEXT_PREFIX);
  }

  /** The `<key>` part of a `$nxx:<key>` reference. */
  public static contextKeyOf(ref: string): string {
    return ref.slice(ACL_CONTEXT_PREFIX.length);
  }

  /** Whether an operator is an equality (vs not-equality) operator. */
  public static isEqualityOperator(operator: NexxusAclConditionOperator): boolean {
    return operator === 'StringEquals' || operator === 'NumericEquals';
  }
}
