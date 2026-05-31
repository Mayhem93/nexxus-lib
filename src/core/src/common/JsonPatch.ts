import type {
  NexxusFieldDef,
  NexxusModelDef,
  NexxusObjectFieldDef,
  NexxusArrayFieldDef,
  NexxusModelPrimitiveType,
  NexxusModelFieldType,
  PrimitiveFieldDef
} from '../common/ModelTypes';
import { INexxusAppModel } from '../models/AppModel';
import { NEXXUS_UNIVERSAL_FIELDS } from './BuiltinSchemas';
import { InvalidJsonPatchException } from '../lib/Exceptions';

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
  appId: string;
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
  validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) => void;
};

export class NexxusJsonPatch {
  private valid: boolean = false;
  private fullPatch: NexxusJsonPatchInternal;

  private static readonly OPERATION_RULES: Record<typeof JSON_OPS[number], OperationRule> = {
    replace: {
      allowedTypes: ['string', 'number', 'boolean', 'date', 'object', 'array'],
      validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) => {
        NexxusJsonPatch.validateAgainstType(value, fieldDef, path);
      }
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

            NexxusJsonPatch.validateAgainstType(value, objFieldDef, path);
          } else {
            const primitiveFieldDef: PrimitiveFieldDef = {
              type: arrayFieldDef.arrayType,
              required: false
            };

            NexxusJsonPatch.validateAgainstType(value, primitiveFieldDef, path);
          }
        } else if (fieldDef.type === 'string') {
          if (typeof value !== 'string') {
            throw new InvalidJsonPatchException(`Value for append at path "${path}" must be a string`);
          }
        }
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

            NexxusJsonPatch.validateAgainstType(value, objFieldDef, path);
          } else {
            const primitiveFieldDef: PrimitiveFieldDef = {
              type: arrayFieldDef.arrayType,
              required: false
            };

            NexxusJsonPatch.validateAgainstType(value, primitiveFieldDef, path);
          }
        } else if (fieldDef.type === 'string') {
          if (typeof value !== 'string') {
            throw new InvalidJsonPatchException(`Value for prepend at path "${path}" must be a string`);
          }
        }
      }
    },
    incr: {
      allowedTypes: ['number', 'date'],
      validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) => {
        NexxusJsonPatch.validateAgainstType(value, fieldDef, path);
      }
    },
    decr: {
      allowedTypes: ['number', 'date'],
      validateValue: (value: any, fieldDef: NexxusFieldDef, path: string) => {
        NexxusJsonPatch.validateAgainstType(value, fieldDef, path);
      }
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

    if (!fullPatch.metadata.appId || typeof fullPatch.metadata.appId !== 'string') {
      throw new InvalidJsonPatchException(`Patch metadata must include appId`);
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
      appId: this.fullPatch.metadata.appId
    };

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

      // Validate value according to operation rules
      operationRule.validateValue(currentValue, fieldDef, currentPath);

      if (!this.fullPatch.metadata.pathFieldTypes) {
        this.fullPatch.metadata.pathFieldTypes = [];
      }

      this.fullPatch.metadata.pathFieldTypes.push(fieldDef.type);
    }

    this.valid = true;
  }

  private static validateAgainstType(
    value: any,
    fieldDef: NexxusFieldDef,
    path: string
  ): void {
    switch (fieldDef.type) {
      case 'string':
        if (typeof value !== 'string') {
          throw new InvalidJsonPatchException(`Expected string at path: ${path}`);
        }
        break;

      case 'number':
        if (typeof value !== 'number' || isNaN(value)) {
          throw new InvalidJsonPatchException(`Expected number at path: ${path}`);
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new InvalidJsonPatchException(`Expected boolean at path: ${path}`);
        }
        break;

      case 'date':
        const date = new Date(value);

        if (isNaN(date.getTime())) {
          throw new InvalidJsonPatchException(`Expected valid date at path: ${path}`);
        }
        break;

      case 'object':
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new InvalidJsonPatchException(`Expected object at path: ${path}`);
        }

        if (NexxusJsonPatch.isObjectFieldDef(fieldDef)) {
          for (const [key, propDef] of Object.entries(fieldDef.properties)) {
            if (propDef.required && !(key in value)) {
              throw new InvalidJsonPatchException(`Required field missing: ${path}.${key}`);
            }

            if (key in value) {
              NexxusJsonPatch.validateAgainstType(value[key], propDef, `${path}.${key}`);
            }
          }
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          throw new InvalidJsonPatchException(`Expected array at path: ${path}`);
        }

        if (NexxusJsonPatch.isArrayFieldDef(fieldDef)) {
          value.forEach((element, index) => {
            const elementPath = `${path}[${index}]`;

            if (fieldDef.arrayType === 'object') {
              if (!fieldDef.properties) {
                throw new InvalidJsonPatchException(`Array of objects at "${path}" is missing properties definition`);
              }

              const objFieldDef: NexxusObjectFieldDef = {
                type: 'object',
                properties: fieldDef.properties,
                required: false
              };

              NexxusJsonPatch.validateAgainstType(element, objFieldDef, elementPath);
            } else {
              const primitiveFieldDef: PrimitiveFieldDef = {
                type: fieldDef.arrayType,
                required: false
              };

              NexxusJsonPatch.validateAgainstType(element, primitiveFieldDef, elementPath);
            }
          });
        }
        break;

      default:
        throw new InvalidJsonPatchException(`Unknown field type at path: ${path}`);
    }
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

  private static validateValueType(
    value: any,
    fieldDef: NexxusFieldDef,
    path: string
  ): boolean {
    const { type } = fieldDef;

    switch (type) {
      case 'string':
        return this.validateString(value, path);

      case 'number':
        return this.validateNumber(value, path);

      case 'boolean':
        return this.validateBoolean(value, path);

      case 'date':
        return this.validateDate(value, path);

      case 'object':
        return this.validateObject(value, fieldDef, path);

      case 'array':
        return this.validateArray(value, fieldDef, path);

      default:
        throw new InvalidJsonPatchException(`Unknown field type "${type}" at path "${path}"`);
    }
  }

  /**
 * Validate string type
 */
  private static validateString(value: any, path: string): boolean {
    if (typeof value !== 'string') {
      throw new InvalidJsonPatchException(`Value at path "${path}" must be a string`);
    }

    return true;
  }

  /**
   * Validate number type
   */
  private static validateNumber(value: any, path: string): boolean {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new InvalidJsonPatchException(`Value at path "${path}" must be a number`);
    }

    return true;
  }

  /**
   * Validate boolean type
   */
  private static validateBoolean(value: any, path: string): boolean {
    if (typeof value !== 'boolean') {
      throw new InvalidJsonPatchException(`Value at path "${path}" must be a boolean`);
    }

    return true;
  }

  /**
   * Validate date type
   */
  private static validateDate(value: string | number, path: string): boolean {
    const isValid = typeof value === 'string' && !isNaN(Date.parse(value)) || typeof value === 'number' && !isNaN(new Date(value).getTime());

    if (!isValid) {
      throw new InvalidJsonPatchException(`Value at path "${path}" must be a valid date`);
    }

    return true;
  }

  /**
   * Validate object type (recursively validates properties)
   */
  private static validateObject(
    value: any,
    fieldDef: NexxusObjectFieldDef,
    path: string
  ): boolean {
    // Basic type check
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new InvalidJsonPatchException(`Value at path "${path}" must be an object`);
    }

    // Validate each property based on fieldDef properties
    for (const key in value) {
      const nestedFieldDef = fieldDef.properties[key];

      if (!nestedFieldDef) {
        throw new InvalidJsonPatchException(`Unknown property "${key}" in object at path "${path}"`);
      }

      const nestedPath = path ? `${path}.${key}` : key;

      this.validateValueType(value[key], nestedFieldDef, nestedPath);
    }

    return true;
  }

  /**
 * Validate array type (recursively validates elements)
 */
  private static validateArray(
    value: any,
    fieldDef: NexxusArrayFieldDef,
    path: string
  ): boolean {
    // Basic type check
    if (!Array.isArray(value)) {
      throw new InvalidJsonPatchException(`Value at path "${path}" must be an array`);
    }

    const { arrayType } = fieldDef;

    // Validate each element based on arrayType
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;

      if (arrayType === 'object') {
        // Leverage validateObject for objects in arrays
        const objDef = fieldDef as any; // Has properties field

        this.validateObject(item, objDef, itemPath);
      } else {
        // For primitive types, use the primitive validator
        this.validatePrimitiveType(item, arrayType, itemPath);
      }
    });

    return true;
  }

  /**
 * Helper to validate primitive types (reusable for arrays)
 */
  private static validatePrimitiveType(
    value: any,
    type: NexxusModelPrimitiveType,
    path: string
  ): boolean {
    switch (type) {
      case 'string':
        return this.validateString(value, path);

      case 'number':
        return this.validateNumber(value, path);

      case 'boolean':
        return this.validateBoolean(value, path);

      case 'date':
        return this.validateDate(value, path);

      default:
        throw new InvalidJsonPatchException(`Unknown primitive type "${type}" at path "${path}"`);
    }
  }

  private static isObjectFieldDef(fieldDef: NexxusFieldDef): fieldDef is NexxusObjectFieldDef {
    return fieldDef.type === 'object';
  }

  private static isArrayFieldDef(fieldDef: NexxusFieldDef): fieldDef is NexxusArrayFieldDef {
    return fieldDef.type === 'array';
  }
}
