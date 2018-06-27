export declare class NexxusApplicationSchema<T> {
	constructor(schema: T)

	private validate()

	belongsTo(modelName: keyof T, parentModel: keyof T): boolean

	hasParent(modelName: keyof T, parentModel: keyof T): boolean

	hasMany(modelName: keyof T, parentModel: keyof T): boolean
}
