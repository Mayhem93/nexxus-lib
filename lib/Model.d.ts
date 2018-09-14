import BaseModel = require('./BaseModel')
import Patch = require('./Patch')

interface NexxusBaseModelProps {
	application_id: string
	context_id: string
	user_id: string
}

interface NexxusBaseModelGetDeleteParameter {
	id: string,
	type: string,
	application_id: string
}

interface NexxusModelConstructor extends BaseModel {
	readonly prototype: NexxusModel
	new(props: NexxusBaseModelProps): NexxusModel

	properties: NexxusBaseModelProps
}

interface NexxusModel extends BaseModel {
	get(objects: Array<NexxusBaseModelGetDeleteParameter>): Array<NexxusModel>
	create(objects: Array<object>): Array<NexxusModel>
	update(patches: Array<Patch>): Array<NexxusModel>
	delete(objects: Map<string, NexxusBaseModelGetDeleteParameter>)
	getFilterFromChannel(channel: object): object
	countByChannel(channel: object): Number
	search(channel: object, sort, offset, limit): Array<NexxusModel>
}

declare const NexxusModelConstructor: NexxusModelConstructor & NexxusModel
