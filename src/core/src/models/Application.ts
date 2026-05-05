import {
  INexxusBaseModel,
  MODEL_REGISTRY
} from "./BaseModel";
import { NexxusBuiltinModel } from "./BuiltinModel";
import { NexxusFieldDef, NexxusModelDef } from "../common/ModelTypes";
import { NexxusUserDetailSchema } from "./User";

import * as Dot from 'dot-prop';

export interface NexxusApplicationSchema {
  [modelName: string]: NexxusModelDef;
}

export interface NexxusUserTypeConfig {
  private?: boolean; // if true users can only be created through the nexxus hub API; defaults to false if not specified
}

export interface INexxusApplication extends INexxusBaseModel<'application'> {
  name: string;
  description?: string;
  schema: NexxusApplicationSchema;
  authEnabled: boolean;
  allowMultipleLogin: boolean | null;
  userTypes?: {
    [userType: string]: NexxusUserTypeConfig;
  }
  userDetailSchema?: {
    [userType: string]: NexxusUserDetailSchema;
  };
}

export class NexxusApplication extends NexxusBuiltinModel<INexxusApplication> {
  constructor(data: INexxusApplication) {
    super({ ...data, type: MODEL_REGISTRY.application });

    if (Object.keys(data.schema).length === 0) {
      throw new Error("Application schema cannot be empty");
    }

    if (data.description !== undefined && typeof data.description !== 'string') {
      throw new Error("Application 'description' must be a string if provided");
    }

    if (data.name === undefined || typeof data.name !== 'string') {
      throw new Error("Application 'name' is required and must be a string");
    }

    if (data.authEnabled === undefined || typeof data.authEnabled !== 'boolean') {
      throw new Error("Application 'authEnabled' is required and must be a boolean");
    }

    if (data.authEnabled) {
      if (!data.userDetailSchema || typeof data.userDetailSchema !== 'object') {
        throw new Error("Application 'userSchema' must be provided when 'authEnabled' is enabled");
      }

      if (typeof data.allowMultipleLogin !== 'boolean' && data.allowMultipleLogin !== undefined) {
        throw new Error("Application 'allowMultipleLogin' must be a boolean when 'authEnabled' is enabled");
      }

      if (data.userTypes !== undefined && typeof data.userTypes !== 'object') {
        throw new Error("Application 'userTypes' must be an object when 'authEnabled' is enabled");
      }

      this.data.allowMultipleLogin = data.allowMultipleLogin || true;
      this.data.userTypes = data.userTypes ? { ...data.userTypes, ...{ default: {} } } : { default: {} };
    } else {
      this.data.allowMultipleLogin = null;
    }

    //TODO: actually use json schema validation for schema structure
  }

  public getSchema(): NexxusApplicationSchema {
    return this.data.schema;
  }

  public getUserDetailSchema(userType: string = 'default'): NexxusUserDetailSchema | null {
    if (!this.data.userDetailSchema) {
      return null;
    }

    return this.data.userDetailSchema[userType];
  }

  public hasAuthEnabled(): boolean {
    return this.data.authEnabled;
  }

  public getAppModelFieldType(modelType: string, fieldPath: string): string | undefined {
    const appModelFieldType = Dot.getProperty(this.getSchema(), `${modelType}.${fieldPath}.type`);

    return appModelFieldType as string | undefined;
  }

  public getModelFilterableFields(modelType: string): Set<string> {
    const modelDef = this.getSchema()[modelType];
    const filterableFields: Set<string> = new Set();

    if (!modelDef) {
      return filterableFields;
    }

    // Recursive helper to traverse nested fields
    const collectFilterableFields = (
      fields: Record<string, NexxusFieldDef>,
      prefix: string = ''
    ): void => {
      for (const [fieldName, fieldDef] of Object.entries(fields)) {
        const fieldPath = prefix ? `${prefix}.${fieldName}` : fieldName;

        if (fieldDef.type === 'object') {
          // Recurse into nested object
          collectFilterableFields(fieldDef.properties, fieldPath);
        } else if (fieldDef.type === 'array') {
          // Skip arrays entirely (not filterable)
          continue;
        } else {
          // Primitive field - check filterable flag
          if (fieldDef.filterable) {
            filterableFields.add(fieldPath);
          }
        }
      }
    };

    collectFilterableFields(modelDef);

    return filterableFields;
  }
}
