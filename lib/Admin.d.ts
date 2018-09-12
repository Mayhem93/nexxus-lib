import { BaseModel, BaseModelProps } from './BaseModel';
import NexxusPatch = require('./Patch');

interface NexxusAdminProps extends BaseModelProps {
	type: 'admin'
}

interface NexxusAdminConstructorProps {
	email: string
}

declare interface NexxusAdminConstructor extends BaseModel {
	readonly prototype: NexxusAdmin
	new(props: NexxusAdminConstructorProps): NexxusAdmin
	create(props: NexxusAdminConstructorProps): NexxusAdmin
	get(id: string): NexxusAdmin
	delete(id: string): void
	update(patches: Array<NexxusPatch>): void
}

declare interface NexxusAdmin extends BaseModel {
	properties: NexxusAdminProps
}

declare const NexxusAdminConstructor: NexxusAdminConstructor & NexxusAdmin

export = NexxusAdminConstructor
