type BaseModelTypes = 'admin' | 'application' | 'context' | 'user' | string;

interface BaseModelProps {
	readonly id: string | Number,
	readonly type: BaseModelTypes
	readonly created: Number,
	readonly updated: Number
}

export declare class BaseModel {
	constructor(props: BaseModelProps, moreImmutableProperties: Array<string>);
}
