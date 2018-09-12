import {BaseModel, BaseModelProps} from './BaseModel';
import NexxusPatch = require('./Patch');

interface NexxusContextProps extends BaseModelProps {
	type: 'context'
	application_id: string
}

declare interface NexxusContextConstructor {
	readonly prototype: NexxusContext
	new(props: NexxusContextProps): NexxusContext
}

declare interface NexxusContext extends BaseModel {
	properties: NexxusContextProps

	get(): (id: string) => NexxusContext

	getAll(appId: string): () => Array<NexxusContext>

	create(appId: string): (props: NexxusContextProps) => NexxusContext

	delete(): (id: string) => void

	update(): (patches: Array<NexxusPatch>) => void
}

declare const NexxusContextConstructor: NexxusContextConstructor & NexxusContext

export = NexxusContextConstructor
