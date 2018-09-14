type BaseModelTypes = 'admin' | 'application' | 'context' | 'user' | string;

interface BaseModelProps {
	readonly id: string | Number,
	readonly type: BaseModelTypes
	readonly created: Number,
	readonly updated: Number
}

interface NexxusBaseModelConstructor {
	readonly: NexxusBaseModel
	new(props: BaseModelProps, moreImmutableProperties: Array<string>): NexxusBaseModel
}

interface NexxusBaseModel {
	properties: BaseModelProps
}

declare const NexxusBaseModelConstructor: NexxusBaseModelConstructor & NexxusBaseModel

export = NexxusBaseModelConstructor
