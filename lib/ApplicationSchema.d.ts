interface SchemaFields {
	[modelName: string]: {
		properties: {
			[fieldName: string]: {
				type: string
			}
		},
		acl_read: Number
		acl_write: Number
		acl_meta: Number
	}
}

interface NexxusApplicationSchemaConstructor<T> {
	readonly prototype: NexxusApplicationSchema<T>
	new(schema: T): NexxusApplicationSchema<T>

	schema: T
	applicationId: string

	validate()

	getModelNames(): Array<string>

	deleteModel(modelName: keyof T): boolean

	belongsTo(modelName: keyof T, parentModel: keyof T): boolean

	hasParent(modelName: keyof T, parentModel: keyof T): boolean

	hasMany(modelName: keyof T, parentModel: keyof T): boolean
}

interface NexxusApplicationSchema<T> {

}

declare const NexxusApplicationSchemaConstructor: NexxusApplicationSchemaConstructor<SchemaFields> & NexxusApplicationSchema<SchemaFields>

export = NexxusApplicationSchemaConstructor
