import NexxusError = require('./NexxusError');
import {BaseModel, BaseModelProps} from './BaseModel';
import {NexxusApplicationSchema} from './ApplicationSchema';
import NexxusContext = require('./Context');

interface NexxusApplicationProps extends BaseModelProps {
	type: 'application'
	admins: Array<string>
	keys: Array<string>
	schema?: NexxusApplicationSchema<object>
	apn_key?: string
	apn_key_id?: string
	apn_team_id?: string
	apn_topic?: string
	gcm_api_key?: string
}

declare class NexxusApplication extends BaseModel {
	properties: NexxusApplicationProps & {type?: ApplicationType}

	constructor(props: NexxusApplicationProps)

	delete(): boolean

	update(patches: Array<object>): boolean

	hasContext(contextId: string): boolean

	isAPNConfigured(): boolean

	isGCMConfigured(): boolean

	updateSchema(schemaObject: NexxusApplicationSchema<object>): boolean

	deleteModel(modelName: string): boolean

	static models: object
	static users: object
	static contexts: NexxusContext

	static getAll(): Array<NexxusApplication>

	static new(props: NexxusApplicationProps): NexxusApplication

	static isAdmin(admin: {id: string, email: string}): boolean

	static isBuiltinModel(modelName: string): boolean
}
