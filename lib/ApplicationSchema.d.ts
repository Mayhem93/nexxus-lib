export declare class NexxusApplicationSchema<T> {
	private schema: T

	constructor(schema: T)

	private validate()

	deleteModel(modelName: keyof T): boolean

	belongsTo(modelName: keyof T, parentModel: keyof T): boolean

	hasParent(modelName: keyof T, parentModel: keyof T): boolean

	hasMany(modelName: keyof T, parentModel: keyof T): boolean
}
