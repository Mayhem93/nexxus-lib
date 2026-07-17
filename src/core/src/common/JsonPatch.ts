import type {
  NexxusFieldDef,
  NexxusModelDef,
  NexxusObjectFieldDef,
  NexxusArrayFieldDef,
  NexxusModelFieldType,
  PrimitiveFieldDef
} from '../common/ModelTypes';
import { INexxusAppModel } from '../models/AppModel';
import { NEXXUS_UNIVERSAL_FIELDS } from './BuiltinSchemas';
import { InvalidJsonPatchException, InvalidSchemaDataException } from '../lib/Exceptions';
import { NexxusSchemaValidator } from './SchemaValidator';

import * as dot from 'dot-prop';

const JSON_OPS = [
  'replace',
  'append',
  'prepend',
  'incr',
  'decr'
] as const;

export type NexxusJsonPatchConstructor = {
  op: typeof JSON_OPS[number];
  path: string[];
  value: any[];
  metadata: NexxusJsonPatchMetadata;
};

export type NexxusJsonPatchMetadata = {
  /**
   * App scope for the patched document. Required for every model type
   * EXCEPT `'setting'`, which is deployment-scoped (no app to belong to).
   * Enforced at construction — see the `NexxusJsonPatch` constructor.
   */
  appId?: string;
  id: string;
  type: string;
  userId?: string;
};

export type NexxusJsonPatchInternal = {
  op: typeof JSON_OPS[number];
  path: string[];
  value: any[];
  metadata: NexxusJsonPatchMetadataInternal;
};


type NexxusJsonPatchMetadataInternal = NexxusJsonPatchMetadata & {
  pathFieldTypes?: NexxusModelFieldType[]; // types of each path field, for easier validation
};

export type NexxusJsonPatchMetadataConstructor = Omit<NexxusJsonPatchMetadata, 'pathFieldTypes'>;

type OperationRule = {
  allowedTypes: NexxusModelFieldType[];
  /**
   * Validates the patch value against the target field definition and returns
   * the normalized value (e.g. date strings → integer timestamps). The patch's
   * own value array is updated in-place with whatever this returns.
   */
  validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) => any;
};

export class NexxusJsonPatch {
  private valid: boolean = false;
  private fullPatch: NexxusJsonPatchInternal;

  private static readonly OPERATION_RULES: Record<typeof JSON_OPS[number], OperationRule> = {
    replace: {
      allowedTypes: ['string', 'number', 'boolean', 'date', 'object', 'array'],
      validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) =>
        NexxusSchemaValidator.validateValue(value, fieldDef, path)
    },
    append: {
      allowedTypes: ['array', 'string'],
      validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) => {
        if (fieldDef.type === 'array') {
          const arrayFieldDef = fieldDef as NexxusArrayFieldDef;

          if (arrayFieldDef.arrayType === 'object') {
            if (!arrayFieldDef.properties) {
              throw new InvalidJsonPatchException(`Array of objects at "${path}" is missing properties definition`);
            }

            const objFieldDef: NexxusObjectFieldDef = {
              type: 'object',
              properties: arrayFieldDef.properties,
              required: false
            };

            return NexxusSchemaValidator.validateValue(value, objFieldDef, path);
          }

          const primitiveFieldDef: PrimitiveFieldDef = {
            type: arrayFieldDef.arrayType,
            required: false
          };

          return NexxusSchemaValidator.validateValue(value, primitiveFieldDef, path);
        }

        if (fieldDef.type === 'string') {
          if (typeof value !== 'string') {
            throw new InvalidJsonPatchException(`Value for append at path "${path}" must be a string`);
          }

          return value;
        }

        // Defensive — `allowedTypes` should prevent reaching here
        throw new InvalidJsonPatchException(`append not supported on type "${fieldDef.type}" at path "${path}"`);
      }
    },
    prepend: {
      allowedTypes: ['array', 'string'],
      validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) => {
        if (fieldDef.type === 'array') {
          const arrayFieldDef = fieldDef as NexxusArrayFieldDef;

          if (arrayFieldDef.arrayType === 'object') {
            if (!arrayFieldDef.properties) {
              throw new InvalidJsonPatchException(`Array of objects at "${path}" is missing properties definition`);
            }

            const objFieldDef: NexxusObjectFieldDef = {
              type: 'object',
              properties: arrayFieldDef.properties,
              required: false
            };

            return NexxusSchemaValidator.validateValue(value, objFieldDef, path);
          }

          const primitiveFieldDef: PrimitiveFieldDef = {
            type: arrayFieldDef.arrayType,
            required: false
          };

          return NexxusSchemaValidator.validateValue(value, primitiveFieldDef, path);
        }

        if (fieldDef.type === 'string') {
          if (typeof value !== 'string') {
            throw new InvalidJsonPatchException(`Value for prepend at path "${path}" must be a string`);
          }

          return value;
        }

        throw new InvalidJsonPatchException(`prepend not supported on type "${fieldDef.type}" at path "${path}"`);
      }
    },
    incr: {
      allowedTypes: ['number', 'date'],
      validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) =>
        NexxusSchemaValidator.validateValue(value, fieldDef, path)
    },
    decr: {
      allowedTypes: ['number', 'date'],
      validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) =>
        NexxusSchemaValidator.validateValue(value, fieldDef, path)
    }
  };

  constructor(fullPatch: NexxusJsonPatchConstructor | NexxusJsonPatchInternal) {
    if (!fullPatch || typeof fullPatch !== 'object' || Array.isArray(fullPatch)) {
      throw new InvalidJsonPatchException(`Invalid patch format`);
    }

    if (!JSON_OPS.includes(fullPatch.op)) {
      throw new InvalidJsonPatchException(`Unsupported JSON Patch operation: ${fullPatch.op}`);
    }

    if (fullPatch.path.length !== fullPatch.value.length) {
      throw new InvalidJsonPatchException(`Path and value arrays must have the same length`);
    }

    if (!fullPatch.metadata.type || typeof fullPatch.metadata.type !== 'string') {
      throw new InvalidJsonPatchException(`Patch metadata must include type`);
    }

    // `setting` is the one deployment-scoped model that has no app to
    // belong to; every other model type is per-app and MUST carry an appId.
    // If more deployment-scoped models get added later, generalize this
    // (e.g. by asking the model class whether it's app-scoped).
    if (fullPatch.metadata.type !== 'setting') {
      if (!fullPatch.metadata.appId || typeof fullPatch.metadata.appId !== 'string') {
        throw new InvalidJsonPatchException(`Patch metadata must include appId`);
      }
    }

    if (!fullPatch.metadata.id || typeof fullPatch.metadata.id !== 'string') {
      throw new InvalidJsonPatchException(`Patch metadata must include id`);
    }

    this.fullPatch = { ...fullPatch, metadata: { ...fullPatch.metadata, pathFieldTypes: [] } };
  }

  public get(): NexxusJsonPatchInternal {
    if (!this.valid) {
      throw new InvalidJsonPatchException('Cannot get JSON Patch before validation');
    }

    return this.fullPatch;
  }

  public isValid(): boolean {
    return this.valid;
  }

  public getPartialModel(): Partial<INexxusAppModel> {
    const partialModel: Partial<INexxusAppModel> = {
      id: this.fullPatch.metadata.id,
      type: this.fullPatch.metadata.type,
    };

    // Only per-app models carry appId; deployment-scoped models (currently
    // `setting`) leave it undefined and the DB adapter routes to a global
    // index rather than the per-app one.
    if (this.fullPatch.metadata.appId) {
      partialModel.appId = this.fullPatch.metadata.appId;
    }

    for (let i = 0; i < this.fullPatch.path.length; i++) {
      const path = this.fullPatch.path[i];
      const value = this.fullPatch.value[i];

      // Set value at path in partialModel
      dot.setProperty(partialModel, path, value);
    }

    return partialModel;
  }

  public validate(schema: NexxusModelDef): void {
    const modelSpec: NexxusModelDef = {
      updatedAt: NEXXUS_UNIVERSAL_FIELDS.updatedAt,
      ...schema
    };

    const operationRule = NexxusJsonPatch.OPERATION_RULES[this.fullPatch.op];

    // Validate each path/value pair
    for (let i = 0; i < this.fullPatch.path.length; i++) {
      const currentPath = this.fullPatch.path[i];
      const currentValue = this.fullPatch.value[i];

      // `version` is set exclusively by the database adapter on writes and must
      // never be patched. We check the top-level segment so neither `version`
      // (replace) nor `version.<anything>` (defensive) can target it. If more
      // system-managed fields join later, extract a constant.
      const topLevelField = currentPath.split('.')[0];

      if (topLevelField === 'version') {
        throw new InvalidJsonPatchException(
          `Cannot patch system-managed field "version" at path "${currentPath}" — it is set exclusively by the database adapter`
        );
      }

      // Find field definition in schema
      const fieldDef = NexxusJsonPatch.traverseSchema(modelSpec, currentPath);

      if (!fieldDef) {
        throw new InvalidJsonPatchException(
          `Path "${currentPath}" does not exist in model "${this.fullPatch.metadata.type}"`
        );
      }

      // Check if operation is allowed on this field type
      if (!operationRule.allowedTypes.includes(fieldDef.type)) {
        throw new InvalidJsonPatchException(
          `Operation "${this.fullPatch.op}" not allowed on type "${fieldDef.type}" at path "${currentPath}"`
        );
      }

      // Validate + normalize the value. SchemaValidator throws InvalidSchemaDataException;
      // rewrap as InvalidJsonPatchException to preserve this class's exception API.
      let normalized: any;

      try {
        normalized = operationRule.validateValue(currentValue, fieldDef, currentPath);
      } catch (e) {
        if (e instanceof InvalidSchemaDataException) {
          throw new InvalidJsonPatchException(e.message);
        }

        throw e;
      }

      // Apply the normalization back to the patch (e.g. date strings → timestamps)
      this.fullPatch.value[i] = normalized;

      if (!this.fullPatch.metadata.pathFieldTypes) {
        this.fullPatch.metadata.pathFieldTypes = [];
      }

      this.fullPatch.metadata.pathFieldTypes.push(fieldDef.type);
    }

    this.valid = true;
  }

  private static traverseSchema(
    schema: NexxusModelDef,
    path: string
  ): NexxusFieldDef | null {
    const parts = path.split('.');
    let current: NexxusModelDef | Record<string, NexxusFieldDef> = schema;

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
        const objDef = fieldDef as NexxusObjectFieldDef;

        current = objDef.properties;
      } else if (fieldDef.type === 'array') {
        const arrDef = fieldDef as NexxusArrayFieldDef;

        // For arrays of objects, traverse into the object properties
        if (arrDef.arrayType === 'object' && 'properties' in arrDef) {
          current = arrDef.properties!;
        } else {
          // Can't traverse further into primitive arrays
          return null;
        }
      } else {
        // Can't traverse into primitive types
        return null;
      }
    }

    return null;
  }
}
