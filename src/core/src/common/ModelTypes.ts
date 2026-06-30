export type NexxusModelPrimitiveType = 'string' | 'number' | 'boolean' | 'date';
export type NexxusModelFieldType = NexxusModelPrimitiveType | 'array' | 'object';

interface BaseFieldDef {
  type: NexxusModelFieldType;
  required?: boolean;
  nullable?: boolean;
}

export interface PrimitiveFieldDef extends BaseFieldDef {
  type: NexxusModelPrimitiveType;
  filterable?: boolean; // Whether the field can be used in filter queries; default is undefined or false
}

export interface NexxusArrayFieldDef extends BaseFieldDef {
  type: 'array';
  arrayType: NexxusModelPrimitiveType | 'object';
  properties?: Record<string, NexxusFieldDef>;
}

export interface NexxusObjectFieldDef extends BaseFieldDef {
  type: 'object';
  properties: Record<string, NexxusFieldDef>;
}

export type NexxusFieldDef = PrimitiveFieldDef | NexxusArrayFieldDef | NexxusObjectFieldDef;

export interface NexxusModelDef {
  [fieldName: string]: NexxusFieldDef;
}
