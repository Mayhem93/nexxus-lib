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
 */
export class NexxusSchemaValidator {

  /**
   * Validate `data` against the model definition, enforcing `required` and
   * the per-field type checks. Iterates the SCHEMA (not the data) so that
   * required fields the caller omits entirely still get caught — the old
   * data-iterating shape silently skipped them.
   *
   * Returns a shallow-merged copy of `data` with each declared value
   * normalized. Unknown fields (present in data but not declared in
   * modelDef) are passed through unchanged — the schema DSL is
   * intentionally open (developers can add ad-hoc fields not covered
   * by their declared schema).
   */
  public static validateAgainstSchema(data: Record<string, unknown>, modelDef: NexxusModelDef): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidSchemaDataException(`Schema validation: input must be a non-null object`);
    }

    // `version` is set exclusively by the database adapter on writes;
    // user input cannot supply it. Checked before the schema loop so it
    // triggers regardless of whether the schema happens to declare it.
    if ('version' in data) {
      throw new InvalidSchemaDataException(
        `Field "version" is a system-managed Nexxus field and cannot be set by user input`
      );
    }

    const result: Record<string, unknown> = { ...data };

    for (const [fieldName, fieldDef] of Object.entries(modelDef)) {
      const value = data[fieldName];
      const absent = !(fieldName in data) || value === undefined;

      if (absent) {
        if (fieldDef.required === true) {
          throw new InvalidSchemaDataException(
            `Required field "${fieldName}" is missing`
          );
        }

        continue;
      }

      if (value === null) {
        if (fieldDef.nullable === true) {
          result[fieldName] = null;

          continue;
        }

        throw new InvalidSchemaDataException(
          `Field "${fieldName}" cannot be null`
        );
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

      case 'int':
        return NexxusSchemaValidator.validateInt(value, path);

      case 'float':
        return NexxusSchemaValidator.validateFloat(value, path);

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

  private static validateInt(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new InvalidSchemaDataException(`Expected integer at path "${path}", got ${typeof value}`);
    }

    return value;
  }

  private static validateFloat(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidSchemaDataException(`Expected float at path "${path}", got ${typeof value}`);
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

    // Same shape as `validateAgainstSchema`: iterate the schema so missing
    // required nested fields are caught, and null/absent handling matches
    // the top-level behaviour.
    for (const [key, propDef] of Object.entries(fieldDef.properties)) {
      const subPath = `${path}.${key}`;
      const subValue = input[key];
      const absent = !(key in input) || subValue === undefined;

      if (absent) {
        if (propDef.required === true) {
          throw new InvalidSchemaDataException(
            `Required field "${subPath}" is missing`
          );
        }

        continue;
      }

      if (subValue === null) {
        if (propDef.nullable === true) {
          result[key] = null;

          continue;
        }

        throw new InvalidSchemaDataException(
          `Field "${subPath}" cannot be null`
        );
      }

      result[key] = NexxusSchemaValidator.validateValue(subValue, propDef, subPath);
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
