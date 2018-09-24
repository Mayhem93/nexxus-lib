import NexxusError = require('./NexxusError');
import BaseModel = require('./BaseModel');
import NexxusApplicationSchema = require('./ApplicationSchema');
import NexxusContext = require('./Context');
import NexxusPatch = require('./Patch');

interface NexxusApplicationProps extends BaseModelProps {
	readonly type: 'application'
}

interface NexxusApplicationParams {
	readonly admins?: Array<string>
	readonly keys?: Array<string>
	readonly schema?: typeof NexxusApplicationSchema
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

	update(patches: Array<NexxusPatch>): boolean

	hasContext(contextId: string): boolean

	setSchema(schemaObject: typeof NexxusApplicationSchema): void

	isAPNConfigured(): boolean

	isGCMConfigured(): boolean

	updateSchema(schemaObject: NexxusApplicationSchema<object>): boolean

	deleteModel(modelName: string): boolean

	hasModel(modelName: string): boolean

	hasSchema(): boolean
}

interface NexxusApplication extends BaseModel {
	contexts: typeof NexxusContext
	models: object
	users: object

	apps(): Map<string, NexxusApplication>
	retrieveAll(): Map<string, NexxusApplication>
	create(props: NexxusApplicationProps & NexxusApplicationParams): NexxusApplication
}

declare const NexxusApplicationConstructor: NexxusApplicationConstructor & NexxusApplication

export = NexxusApplicationConstructor
