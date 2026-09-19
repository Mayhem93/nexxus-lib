import type {
  NexxusFieldDef,
  NexxusModelDef,
  NexxusObjectFieldDef,
  NexxusArrayFieldDef,
  PrimitiveFieldDef
} from './ModelTypes';
import { InvalidSchemaDataException } from '../lib/Exceptions';
import { NEXXUS_RESERVED_FIELD_NAMES } from './BuiltinSchemas';

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
   * normalized. Fields NOT declared in `modelDef` are rejected: the schema is
   * closed, so what a developer declares is exactly what can be stored.
   *
   * Closed rather than open because a database adapter has to commit to a
   * shape for anything it persists, and an undeclared field forces it to infer
   * one from whatever value happens to arrive first. That inference can be
   * irreversible for the life of the store, and it is made per-deployment by
   * whichever adapter is plugged in — so the same application would behave
   * differently on two backends. A schema that isn't enforced isn't a schema.
   */
  public static validateAgainstSchema(data: Record<string, unknown>, modelDef: NexxusModelDef): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidSchemaDataException(`Schema validation: input must be a non-null object`);
    }

    // `version` is set exclusively by the database adapter on writes;
    // user input cannot supply it. Checked before the undeclared-field sweep
    // below so it keeps its own, more specific message.
    if ('version' in data) {
      throw new InvalidSchemaDataException(
        `Field "version" is a system-managed Nexxus field and cannot be set by user input`
      );
    }

    // Reserved names are exempt because they're system-managed and set by the
    // API/Worker at construction (`id`, `type`, `appId`, `userId`, …), never
    // declared by the developer — an application schema is actually FORBIDDEN
    // from declaring them, so they can't be in `modelDef` to be found.
    const undeclared = Object.keys(data)
      .filter(field => !(field in modelDef) && !NEXXUS_RESERVED_FIELD_NAMES.has(field));

    if (undeclared.length > 0) {
      throw new InvalidSchemaDataException(
        `Field(s) "${undeclared.join('", "')}" are not declared in the schema`
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
  /**
   * Normalize a `date` value to an integer UNIX timestamp in SECONDS.
   *
   * Seconds is the canonical unit for every date Nexxus stores — it's what
   * `NexxusBaseModel` stamps `createdAt`/`updatedAt` with, so anything arriving
   * in another form is converted here rather than leaving a document holding
   * two different units in two fields.
   *
   * A bare NUMBER is taken to already be in that unit and passed through. It
   * has to be: `1577836800` is a valid instant in both seconds and
   * milliseconds, so there is nothing to detect and guessing would be wrong
   * eventually. A caller with milliseconds should send a Date or an ISO string
   * and let this convert.
   */
  private static validateDate(value: unknown, path: string): number {
    // A Date is the least ambiguous thing a `date` field can be handed, and
    // server-side code building a patch naturally reaches for `new Date()`.
    // Rejecting it while accepting a date STRING was a trap: `getTime()` on an
    // Invalid Date is NaN, which is the only Date that should fail here.
    //
    // No risk of widening what a client can send — JSON has no date type, so a
    // Date instance can only ever come from our own code.
    if (value instanceof Date) {
      const ts = value.getTime();

      if (Number.isFinite(ts)) {
        return Math.floor(ts / 1000);
      }

      throw new InvalidSchemaDataException(`Expected valid date at path "${path}", got an Invalid Date`);
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.floor(value);
    }

    if (typeof value === 'string') {
      // Try plain numeric string first (cheap, no Date parsing). Already in
      // seconds, like a bare number.
      const asNum = Number(value);

      if (Number.isFinite(asNum)) {
        return Math.floor(asNum);
      }

      // Try ISO/parseable date string — milliseconds, so convert.
      const ts = new Date(value).getTime();

      if (Number.isFinite(ts)) {
        return Math.floor(ts / 1000);
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

    // Closed, like the top level — but with no reserved-name exemption: system
    // fields only ever live at the root of a model, so anything undeclared
    // down here is undeclared, full stop.
    const undeclared = Object.keys(input).filter(key => !(key in fieldDef.properties));

    if (undeclared.length > 0) {
      throw new InvalidSchemaDataException(
        `Field(s) "${undeclared.join('", "')}" at path "${path}" are not declared in the schema`
      );
    }

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
