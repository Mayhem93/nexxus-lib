import {
  NexxusAclGrammar,
  type NexxusAclCondition,
  type NexxusAclConditionOperator,
  type NexxusAclConditionBlock,
  type NexxusAclContext,
} from '../common/AclStatement';
import type { NexxusFilterQueryType } from '../common/FilterQuery';

/**
 * Lowers a validated statement condition into a `NexxusFilterQueryType`,
 * resolving `$nxx:*` references against the request context. That one filter
 * serves both uses: `.test(object)` for single-object checks, and injection
 * into the DB / subscription query for collection reads. This unit only
 * builds the filter — it doesn't decide allow/deny or know about roles.
 */
export class NexxusAclConditionResolver {
  /**
   * Build the filter for a condition, or `null` when it can't be satisfied in
   * this context (a referenced key is absent) — the caller then treats that
   * allow as not applying.
   */
  public static resolve(condition: NexxusAclCondition, ctx: NexxusAclContext): NexxusFilterQueryType | null {
    const fragments: NexxusFilterQueryType[] = [];

    for (const operator of Object.keys(condition) as NexxusAclConditionOperator[]) {
      const block = condition[operator];

      if (!block) {
        continue;
      }

      const fragment = NexxusAclConditionResolver.resolveBlock(operator, block, ctx);

      // A block with no usable values → the whole condition (AND) is unsatisfiable.
      if (fragment === null) {
        return null;
      }

      fragments.push(...fragment);
    }

    if (fragments.length === 0) {
      return null;
    }

    if (fragments.length === 1) {
      return fragments[0];
    }

    return { $and: fragments } as NexxusFilterQueryType;
  }

  /** One operator block → its per-field filter fragments, or `null` if any
   *  field ends up with no resolvable value (making the AND unsatisfiable). */
  private static resolveBlock(
    operator: NexxusAclConditionOperator,
    block: NexxusAclConditionBlock,
    ctx: NexxusAclContext,
  ): NexxusFilterQueryType[] | null {
    const fragments: NexxusFilterQueryType[] = [];

    for (const [field, rawValues] of Object.entries(block)) {
      const values: Array<string | number> = [];

      for (const rawValue of rawValues) {
        const resolved = NexxusAclConditionResolver.resolveValue(rawValue, ctx);

        // Missing context key → drop this value from the field's OR set.
        if (resolved !== undefined) {
          values.push(resolved);
        }
      }

      if (values.length === 0) {
        return null;
      }

      fragments.push(NexxusAclConditionResolver.buildFieldFilter(operator, field, values));
    }

    return fragments;
  }

  private static resolveValue(raw: string | number, ctx: NexxusAclContext): string | number | undefined {
    if (typeof raw === 'number') {
      return raw;
    }

    if (NexxusAclGrammar.isContextRef(raw)) {
      return ctx[NexxusAclGrammar.contextKeyOf(raw) as keyof NexxusAclContext];
    }

    return raw;
  }

  private static buildFieldFilter(
    operator: NexxusAclConditionOperator,
    field: string,
    values: Array<string | number>,
  ): NexxusFilterQueryType {
    if (NexxusAclGrammar.isEqualityOperator(operator)) {
      return (values.length === 1
        ? { [field]: values[0] }
        : { [field]: { in: values } }) as NexxusFilterQueryType;
    }

    // NotEquals: single → ne; multiple → AND of ne (must differ from all).
    return (values.length === 1
      ? { [field]: { ne: values[0] } }
      : { $and: values.map(value => ({ [field]: { ne: value } })) }) as NexxusFilterQueryType;
  }
}
