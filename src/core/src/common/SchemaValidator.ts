import type {
  NexxusFieldDef,
  NexxusModelDef,
  NexxusObjectFieldDef,
  NexxusArrayFieldDef,
  PrimitiveFieldDef
} from './ModelTypes';
import { InvalidSchemaDataException } from '../lib/Exceptions';

/**
 * Pure schema-aware validation + normalization for a single value against a
 * field definition, or for whole-model data against a model definition.
 *
 * Returns a normalized copy of the input value (e.g. date strings become
 * integer timestamps). Throws InvalidSchemaDataException on the first violation.
 *
 * Used by:
 *   - NexxusJsonPatch (per-path validation on patch operations)
 *   - NexxusAppModel (whole-model validation on construction)
 *
 * Required-field checking is intentionally NOT performed here yet; only fields
 * present in the input are validated.
 */
export class NexxusSchemaValidator {

  /**
   * Validate every present field of `data` against the model definition.
   * Returns a shallow-merged copy of `data` with each value normalized.
   * Unknown fields (present in data but not declared in modelDef) are passed
   * through unchanged.
   */
  public static validateAgainstSchema(data: Record<string, unknown>, modelDef: NexxusModelDef): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidSchemaDataException(`Schema validation: input must be a non-null object`);
    }

    const result: Record<string, unknown> = { ...data };

    for (const [fieldName, value] of Object.entries(data)) {
      // `version` is set exclusively by the database adapter on writes;
      // user input cannot supply it. If more system-managed fields join later,
      // extract a NEXXUS_SYSTEM_MANAGED_FIELDS constant at that point.
      if (fieldName === 'version') {
        throw new InvalidSchemaDataException(
          `Field "version" is a system-managed Nexxus field and cannot be set by user input`
        );
      }

      const fieldDef = modelDef[fieldName];

      if (!fieldDef) {
        continue;
      }

      result[fieldName] = NexxusSchemaValidator.validateValue(value, fieldDef, fieldName);
    }

    return result;
  }

  /**
   * Validate a single value against a field definition. Returns the normalized
   * value. Throws InvalidSchemaDataException on failure.
   *
   * `path` is used only for error messages.
   */
  public static validateValue(value: unknown, fieldDef: NexxusFieldDef, path: string): unknown {
    switch (fieldDef.type) {
      case 'string':
        return NexxusSchemaValidator.validateString(value, path);

      case 'number':
        return NexxusSchemaValidator.validateNumber(value, path);

      case 'boolean':
        return NexxusSchemaValidator.validateBoolean(value, path);

      case 'date':
        return NexxusSchemaValidator.validateDate(value, path);

      case 'object':
        return NexxusSchemaValidator.validateObject(value, fieldDef as NexxusObjectFieldDef, path);

      case 'array':
        return NexxusSchemaValidator.validateArray(value, fieldDef as NexxusArrayFieldDef, path);

      default:
        throw new InvalidSchemaDataException(`Unknown field type at path "${path}"`);
    }
  }

  private static validateString(value: unknown, path: string): string {
    if (typeof value !== 'string') {
      throw new InvalidSchemaDataException(`Expected string at path "${path}", got ${typeof value}`);
    }

    return value;
  }

  private static validateNumber(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidSchemaDataException(`Expected number at path "${path}", got ${typeof value}`);
    }

    return value;
  }

  private static validateBoolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') {
      throw new InvalidSchemaDataException(`Expected boolean at path "${path}", got ${typeof value}`);
    }

    return value;
  }

  /**
   * Accepts: number (ms timestamp), ISO date string, or numeric string.
   * Returns: integer ms timestamp.
   *
   * This is the single canonical date parser for the system; the previous
   * inconsistency between `Date.parse()` and `new Date(s).getTime()` is gone.
   */
  private static validateDate(value: unknown, path: string): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      // Try plain numeric string first (cheap, no Date parsing)
      const asNum = Number(value);

      if (Number.isFinite(asNum)) {
        return asNum;
      }

      // Try ISO/parseable date string
      const ts = new Date(value).getTime();

      if (Number.isFinite(ts)) {
        return Math.floor(ts);
      }
    }

    throw new InvalidSchemaDataException(`Expected valid date at path "${path}", got "${String(value)}"`);
  }

  private static validateObject(value: unknown, fieldDef: NexxusObjectFieldDef, path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidSchemaDataException(`Expected object at path "${path}"`);
    }

    const input = value as Record<string, unknown>;
    const result: Record<string, unknown> = { ...input };

    for (const [key, propDef] of Object.entries(fieldDef.properties)) {
      if (key in input) {
        result[key] = NexxusSchemaValidator.validateValue(input[key], propDef, `${path}.${key}`);
      }
    }

    return result;
  }

  private static validateArray(value: unknown, fieldDef: NexxusArrayFieldDef, path: string): unknown[] {
    if (!Array.isArray(value)) {
      throw new InvalidSchemaDataException(`Expected array at path "${path}"`);
    }

    return value.map((element, index) => {
      const elementPath = `${path}[${index}]`;

      if (fieldDef.arrayType === 'object') {
        if (!fieldDef.properties) {
          throw new InvalidSchemaDataException(`Array of objects at "${path}" is missing properties definition`);
        }

        const objFieldDef: NexxusObjectFieldDef = {
          type: 'object',
          properties: fieldDef.properties,
        };

        return NexxusSchemaValidator.validateObject(element, objFieldDef, elementPath);
      }

      const primitiveFieldDef: PrimitiveFieldDef = {
        type: fieldDef.arrayType,
      };

      return NexxusSchemaValidator.validateValue(element, primitiveFieldDef, elementPath);
    });
  }
}
