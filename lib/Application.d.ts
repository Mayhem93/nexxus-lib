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

	contexts: typeof NexxusContext
	models: object
	users: object

	getAll(): Array<NexxusApplication>
	create(props: NexxusApplicationProps & NexxusApplicationParams): NexxusApplication
	isAdmin(admin: { id: string, email: string }): boolean
}

declare interface NexxusApplication extends BaseModel {
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

	isAPNConfigured(): boolean

	isGCMConfigured(): boolean

	updateSchema(schemaObject: NexxusApplicationSchema<object>): boolean

	deleteModel(modelName: string): boolean

	hasModel(modelName: string): boolean

	hasSchema(): boolean
}

declare const NexxusApplicationConstructor: NexxusApplicationConstructor & NexxusApplication

export = NexxusApplicationConstructor
