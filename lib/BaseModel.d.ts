import NexxusError = require('./NexxusError');

type BaseModelTypes = 'admin' | 'application' | 'context' | 'user';

interface BaseModelPropsParam {
	id: string,
	type: BaseModelTypes
	created: Number,
	updated: Number
}

declare class BaseModel {
	constructor(props: BaseModelPropsParam, moreImmutableProperties: Array<string>);
}

export = BaseModel;
