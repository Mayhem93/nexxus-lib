import NexxusError = require('./lib/NexxusError')

export class NexxusPromise<T> implements Promise<T> {
	then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: NexxusError | Array<NexxusError>) => TResult2 | PromiseLike<TResult2>) | undefined | null): Promise<TResult1 | TResult2>;
	catch<TResult = never>(onrejected?: ((reason: NexxusError | Array<NexxusError>) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult>;
}

declare enum ModelFieldTypes {
	INT = 'int',
	FLOAT = 'float',
	STRING = 'string',
	GEOLOCATION = 'geolocation',
	ARRAY = 'array',
	OBJECT = 'object',
	BOOL = 'bool'
}

declare interface BaseModelSettings {
	reservedFieldNames: Array<keyof BaseModelReservedFieldNames>
}

declare enum BaseModelReservedFieldNames {
	id = 'id',
	type = 'type',
	modified = 'modified',
	created = 'created'
}

declare interface ApplicationSettings {
	reservedFieldNames: Array<keyof ApplicationReservedFieldNames>
}

declare enum ApplicationReservedFieldNames {
	admins = 'admins',
	keys = 'keys'
}

declare interface ContextSettings {
	reservedFieldNames: Array<keyof ContextReservedFieldNames>
}

declare enum ContextReservedFieldNames {
	application_id = 'application_id'
}

declare interface AppModelSettings {
	reservedFieldNames: Array<keyof AppModelReservedFieldNames>
}

declare enum AppModelReservedFieldNames {
	application_id = 'application_id',
	context_id = 'context_id'
}

declare enum BuiltInModels {
	application = 'application',
	admin = 'admin',
	user = 'user',
	context = 'context'
}

declare const CHANNEL_KEY_PREFIX: string

declare interface constants {
	fieldTypes: ModelFieldTypes
	BaseModel: BaseModelSettings
	Application: ApplicationSettings
	Context: ContextSettings
	ApplicationModel: AppModelSettings
	builtinModels: BuiltInModels
	CHANNEL_KEY_PREFIX
}

export declare interface ServiceOptions {
	serviceType: string,
	nodeIndex: number,
	configFile: string,
	configFileSpec: string
}
