import { BaseModel, BaseModelProps } from './BaseModel';

interface NexxusUserProps extends BaseModelProps {
	type: 'user',
	application_id: string,
	username: string
}

interface NexxusUserConstructor extends BaseModel {
	readonly prototype: NexxusUser
	new(props: NexxusUserProps): NexxusUser
	get(id: string): NexxusUser
}

interface NexxusUser extends BaseModel {
	properties: NexxusUserProps
}

declare const NexxusUserConstructor: NexxusUserConstructor & NexxusUser

export = NexxusUserConstructor
