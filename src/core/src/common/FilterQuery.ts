import {
  InvalidQueryFilterException
} from '../lib/Exceptions';
import type {
  NexxusArrayFieldDef,
  NexxusFieldDef,
  NexxusModelDef
} from '../common/ModelTypes';
import { NEXXUS_UNIVERSAL_FIELDS } from './BuiltinSchemas';
import type {
  INexxusAppModel
} from '../models/AppModel';

import * as dot from 'dot-prop';
import sortKeys from 'sort-keys';

// Comparison operators (easily expandable)
export type NexxusComparisonOperator =
  | 'gte'  // greater than or equal
  | 'lte'  // less than or equal
  | 'gt'   // greater than
  | 'lt'   // less than
  | 'ne'   // not equal
  | 'in';  // in array (AND with values)

// Logical operators
export type NexxusLogicalOperator = '$and' | '$or';

// Field value types
export type NexxusFieldValue = string | number | boolean;

// Field condition: either direct value (equality) or operator-based comparison
export type NexxusFieldCondition =
  | NexxusFieldValue  // Simple equality: { "field": "value" }
  | Partial<Record<NexxusComparisonOperator, NexxusFieldValue | NexxusFieldValue[]>>;

// Filter query structure (recursive for logical operators)
export type NexxusFilterQueryType =
  | { [field: string]: NexxusFieldCondition }
  | { [op in NexxusLogicalOperator]?: NexxusFilterQueryType[] };

export type FilterNode =
  | { type: 'field', field: string, operator: 'eq', value: NexxusFieldValue }
  | { type: 'field', field: string, operator: NexxusComparisonOperator, value: NexxusFieldValue | NexxusFieldValue[] }
  | { type: 'logical', operator: NexxusLogicalOperator, conditions: FilterNode[] };

type FilterNodeWithContext = FilterNode & {
  depth: number;
  parentOperator?: NexxusLogicalOperator;
};

export class NexxusFilterQuery {
  private nodes: FilterNode[] = [];
  private modelDef: NexxusModelDef;

  constructor(
    private query: NexxusFilterQueryType,
    schema: NexxusModelDef
  ) {
    this.modelDef = { ...NEXXUS_UNIVERSAL_FIELDS, ...schema };
    this.validateAndParse();
  }

  public getNodes(): FilterNode[] {
    return this.nodes;
  }

  public getNormalizedQuery(): NexxusFilterQueryType {
    return sortKeys(this.query, { deep: true }) as NexxusFilterQueryType;
  }

  *[Symbol.iterator](): Generator<FilterNodeWithContext> {
    yield* this.traverseNodes(this.nodes, 0);
  }

  public test(object: Partial<INexxusAppModel>): boolean {
    return this.nodes.every(node => this.testNode(node, object));
  }

  private testNode(node: FilterNode, object: Partial<INexxusAppModel>): boolean {
    if (node.type === 'field') {
      return this.testFieldCondition(node, object);
    }

    // Logical node - recurse into conditions
    if (node.operator === '$and') {
      // All conditions must match
      return node.conditions.every(childNode => this.testNode(childNode, object));
    }
    // '$or'
    // At least one condition must match

    return node.conditions.some(childNode => this.testNode(childNode, object));
  }

  private validateAndParse(): void {
    this.nodes = this.parseQuery(this.query, this.modelDef);
  }

  private parseQuery(
    query: NexxusFilterQueryType,
    modelSchema: NexxusModelDef
  ): FilterNode[] {
    const nodes: FilterNode[] = [];

    for (const key in query) {
      // Check if it's a logical operator
      if (key === '$and' || key === '$or') {
        const conditions = query[key];

        if (!Array.isArray(conditions) || conditions.length === 0) {
          throw new InvalidQueryFilterException(`Logical operator "${key}" must have at least one condition`);
        }

        // Recursively parse each condition
        const childNodes = conditions.flatMap(cond =>
          this.parseQuery(cond, modelSchema)
        );

        nodes.push({
          type: 'logical',
          operator: key,
          conditions: childNodes
        });
      } else {
        // It's a field condition - narrow the type
        const condition = (query as Record<string, NexxusFieldCondition>)[key];
        const fieldNode = this.parseFieldCondition(key, condition, modelSchema);

        nodes.push(fieldNode);
      }
    }

    return nodes;
  }

  private testFieldCondition(
    node: FilterNode & { type: 'field' },
    object: Partial<INexxusAppModel>
  ): boolean {
    const actualValue = dot.getProperty(object, node.field);

    if (actualValue === undefined) {
      return false;
    }

    switch (node.operator) {
      case 'eq':
        return actualValue === node.value;

      case 'ne':
        return actualValue !== node.value;

      case 'gt':
        return typeof actualValue === 'number' && actualValue > (node.value as number);

      case 'gte':
        return typeof actualValue === 'number' && actualValue >= (node.value as number);

      case 'lt':
        return typeof actualValue === 'number' && actualValue < (node.value as number);

      case 'lte':
        return typeof actualValue === 'number' && actualValue <= (node.value as number);

      case 'in': {
        const values = node.value as NexxusFieldValue[];

        return values.some(v => actualValue === v);
      }
      default:
        return false;
    }
  }

  private parseFieldCondition(
    path: string,
    condition: NexxusFieldCondition,
    modelSchema: NexxusModelDef
  ): FilterNode {
    // Get field definition using dot notation path
    const fieldDef = this.getFieldFromPath(path, modelSchema);

    if (!fieldDef) {
      throw new InvalidQueryFilterException(`Field "${path}" does not exist in model schema`);
    }

    if (fieldDef.type === 'object' || fieldDef.type === 'array') {
      throw new InvalidQueryFilterException(`Cannot filter on non-primitive field "${path}"`);
    }

    if (!fieldDef.filterable) {
      throw new InvalidQueryFilterException(`Field "${path}" is not filterable`);
    }

    // Simple equality check
    if (typeof condition !== 'object' || condition === null) {
      this.validateValueType(condition, fieldDef, path);

      return {
        type: 'field',
        field: path,
        operator: 'eq',
        value: condition
      };
    }

    // Operator-based condition
    const operators = Object.keys(condition) as NexxusComparisonOperator[];

    if (operators.length === 0) {
      throw new InvalidQueryFilterException(`Field "${path}" has empty operator object`);
    }

    if (operators.length > 1) {
      throw new InvalidQueryFilterException(`Field "${path}" can only have one operator per condition`);
    }

    const operator = operators[0];
    const value = condition[operator];

    // Validate operator is valid
    this.validateOperator(operator, fieldDef, path);

    // Validate value type
    if (operator === 'in') {
      if (!Array.isArray(value)) {
        throw new InvalidQueryFilterException(`Operator "in" at path "${path}" must have an array value`);
      }
      value.forEach(v => this.validateValueType(v, fieldDef, path));
    } else {
      this.validateValueType(value as NexxusFieldValue, fieldDef, path);
    }

    return {
      type: 'field',
      field: path,
      operator,
      value: value!
    };
  }

  private getFieldFromPath(
    path: string,
    modelSchema: NexxusModelDef
  ): NexxusFieldDef | null {
    const parts = path.split('.');
    let current: NexxusModelDef | Record<string, NexxusFieldDef> = modelSchema;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (!(part in current)) {
        return null;
      }

      const fieldDef = current[part];

      // If this is the last part, return the field definition
      if (i === parts.length - 1) {
        return fieldDef;
      }

      // Navigate into nested structure
      if (fieldDef.type === 'object') {
        current = fieldDef.properties;
      } else {
        // Can't traverse further into non-object types
        return null;
      }
    }

    return null;
  }

  private validateOperator(
    operator: NexxusComparisonOperator,
    fieldDef: NexxusFieldDef,
    path: string
  ): void {
    const { type } = fieldDef;

    // Comparison operators (gte, lte, gt, lt) only work on numbers and dates
    const comparisonOps: NexxusComparisonOperator[] = ['gte', 'lte', 'gt', 'lt'];

    if (comparisonOps.includes(operator)) {
      if (type !== 'number' && type !== 'date') {
        throw new InvalidQueryFilterException(
          `Operator "${operator}" at path "${path}" can only be used with number or date fields`
        );
      }
    }

    // 'in' operator works with arrays or primitive fields
    if (operator === 'in') {
      if (type === 'object') {
        throw new InvalidQueryFilterException(
          `Operator "in" at path "${path}" cannot be used with object fields`
        );
      }
    }
  }

  private validateValueType(
    value: NexxusFieldValue,
    fieldDef: NexxusFieldDef,
    path: string
  ): void {
    const { type } = fieldDef;

    switch (type) {
      case 'string':
        if (typeof value !== 'string') {
          throw new InvalidQueryFilterException(`Value at path "${path}" must be a string`);
        }
        break;

      case 'number':
        if (typeof value !== 'number' || isNaN(value)) {
          throw new InvalidQueryFilterException(`Value at path "${path}" must be a number`);
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new InvalidQueryFilterException(`Value at path "${path}" must be a boolean`);
        }
        break;

      case 'date':
        const isValidDate =
          (typeof value === 'number' && !isNaN(value)) || // Unix timestamp
          (typeof value === 'string' && !isNaN(Date.parse(value))); // ISO string

        if (!isValidDate) {
          throw new InvalidQueryFilterException(`Value at path "${path}" must be a Unix timestamp or ISO date string`);
        }
        break;

      case 'array':
        // For array fields, we check if the value matches the arrayType
        const arrayFieldDef = fieldDef as NexxusArrayFieldDef;
        const arrayType = arrayFieldDef.arrayType;

        switch (arrayType) {
          case 'string':
            if (typeof value !== 'string') {
              throw new InvalidQueryFilterException(`Value at path "${path}" must be a string (array contains strings)`);
            }
            break;
          case 'number':
            if (typeof value !== 'number') {
              throw new InvalidQueryFilterException(`Value at path "${path}" must be a number (array contains numbers)`);
            }
            break;
          case 'boolean':
            if (typeof value !== 'boolean') {
              throw new InvalidQueryFilterException(`Value at path "${path}" must be a boolean (array contains booleans)`);
            }
            break;
          case 'date':
            if (typeof value !== 'string' || isNaN(Date.parse(value))) {
              throw new InvalidQueryFilterException(`Value at path "${path}" must be an ISO date string (array contains dates)`);
            }
            break;
          case 'object':
            throw new InvalidQueryFilterException(`Cannot query array of objects at path "${path}". Use dot notation for nested fields.`);
        }
        break;

      case 'object':
        throw new InvalidQueryFilterException(`Cannot query object field "${path}" directly. Use dot notation for nested fields.`);
    }
  }

  private *traverseNodes(
    nodes: FilterNode[],
    depth: number,
    parentOperator?: NexxusLogicalOperator
  ): Generator<FilterNodeWithContext> {
    for (const node of nodes) {
      yield { ...node, depth, parentOperator };

      if (node.type === 'logical') {
        yield* this.traverseNodes(node.conditions, depth + 1, node.operator);
      }
    }
  }
}
