import {BaseModel, BaseModelProps} from './BaseModel';

interface NexxusContextProps extends BaseModelProps {
	type: 'context'
	application_id: string
}

declare interface INexxusContext extends BaseModel {
	properties: NexxusContextProps

	constructor(props: NexxusContextProps)
}

declare interface NexxusContext extends BaseModel {
	get(): (id: string) => INexxusContext

	getAll(appId: string): () => Array<INexxusContext>

	new(appId: string): (props: NexxusContextProps) => INexxusContext

	delete(): (id: string) => void

	update(): (patches: string) => void
}

declare class NexxusContext implements NexxusContext {}

export = NexxusContext;
