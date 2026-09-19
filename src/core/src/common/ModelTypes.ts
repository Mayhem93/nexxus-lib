export type NexxusModelPrimitiveType = 'string' | 'int' | 'float' | 'boolean' | 'date';
export type NexxusModelFieldType = NexxusModelPrimitiveType | 'array' | 'object';

interface BaseFieldDef {
  type: NexxusModelFieldType;
  required?: boolean;
  nullable?: boolean;
  /**
   * When true, this field is mirrored into the Redis field cache so ACL
   * conditions can reference it without reading the main database. Applies to
   * any field type (objects/arrays are cached as JSON). Only meaningful when
   * the owning Application has `acl` enabled.
   */
  acl?: boolean;
}

export interface PrimitiveFieldDef extends BaseFieldDef {
  type: NexxusModelPrimitiveType;
  filterable?: boolean; // Whether the field can be used in filter queries; default is undefined or false
}

export interface NexxusArrayFieldDef extends BaseFieldDef {
  type: 'array';
  arrayType: NexxusModelPrimitiveType | 'object';
  properties?: Record<string, NexxusFieldDef>;
  /**
   * Whether membership queries (equality = "contains", `in` = "contains any")
   * may target this array field. Only valid for primitive `arrayType`s.
   */
  filterable?: boolean;
}

export interface NexxusObjectFieldDef extends BaseFieldDef {
  type: 'object';
  properties: Record<string, NexxusFieldDef>;
}

export type NexxusFieldDef = PrimitiveFieldDef | NexxusArrayFieldDef | NexxusObjectFieldDef;

export interface NexxusModelDef {
  [fieldName: string]: NexxusFieldDef;
}
