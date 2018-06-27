import NexxusError = require('./NexxusError');

type BaseModelTypes = 'admin' | 'application' | 'context' | 'user';

interface BaseModelProps {
	id: string | Number,
	type: BaseModelTypes
	created: Number,
	updated: Number
}

export declare class BaseModel {
	constructor(props: BaseModelProps, moreImmutableProperties: Array<string>);
}
