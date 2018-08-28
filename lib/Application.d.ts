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

declare class NexxusApp extends BaseModel {
	models: object
	users: object
	static contexts: NexxusContext

	properties: NexxusApplicationProps & NexxusApplicationParams
	contexts: {
		create: ReturnType<NexxusContext["create"]>
		get: ReturnType<NexxusContext["get"]>
		update: ReturnType<NexxusContext["update"]>
		delete: ReturnType<NexxusContext["delete"]>
	}

	constructor(props: NexxusApplicationParams)

	delete(): boolean

	update(patches: Array<object>): boolean

	hasContext(contextId: string): boolean

	isAPNConfigured(): boolean

	isGCMConfigured(): boolean

	updateSchema(schemaObject: NexxusApplicationSchema<object>): boolean

	deleteModel(modelName: string): boolean

	static getAll(): Array<NexxusApp>

	static create(props: NexxusApplicationProps): NexxusApp

	static isAdmin(admin: { id: string, email: string }): boolean

	static isBuiltinModel(modelName: string): boolean
}

declare const NexxusApplication: (appId: string) => NexxusApp | NexxusApp

export = NexxusApplication
