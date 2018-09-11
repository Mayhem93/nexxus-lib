import NexxusError = require('./NexxusError');
import {BaseModel, BaseModelProps} from './BaseModel';
import {NexxusApplicationSchema} from './ApplicationSchema';
import NexxusContext = require('./Context');

interface NexxusApplicationProps extends BaseModelProps {
	readonly type: 'application'
}

interface NexxusApplicationParams {
	readonly admins?: Array<string>
	readonly keys?: Array<string>
	readonly schema?: NexxusApplicationSchema<object>
	apn_key?: string
	apn_key_id?: string
	apn_team_id?: string
	apn_topic?: string
	gcm_api_key?: string
}

interface NexxusApplicationConstructor extends BaseModel {
	readonly prototype: NexxusApplication
	new(props: BaseModelProps & NexxusApplicationParams): NexxusApplication

	properties: NexxusApplicationProps & NexxusApplicationParams
	contexts: {
		create: ReturnType<NexxusContext["create"]>
		get: ReturnType<NexxusContext["get"]>
		update: ReturnType<NexxusContext["update"]>
		delete: ReturnType<NexxusContext["delete"]>
	}

	delete(): boolean

	update(patches: Array<object>): boolean

	hasContext(contextId: string): boolean

	isAdmin(id: string): boolean

	isAPNConfigured(): boolean

	isGCMConfigured(): boolean

	updateSchema(schemaObject: NexxusApplicationSchema<object>): boolean

	deleteModel(modelName: string): boolean

	hasModel(modelName: string): boolean

	hasSchema(): boolean
}

declare interface NexxusApplication extends BaseModel {
	contexts: typeof NexxusContext
	models: object
	users: object


	apps(): Map<string, NexxusApplication>
	retrieveAll(): Map<string, NexxusApplication>
	create(props: NexxusApplicationProps & NexxusApplicationParams): NexxusApplication
}

declare const NexxusApplicationConstructor: NexxusApplicationConstructor & NexxusApplication

export = NexxusApplicationConstructor
