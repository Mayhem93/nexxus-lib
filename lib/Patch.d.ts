import NexxusModel = require('./Model');

declare enum PatchOperations {
	append = 'append',
	increment = 'increment',
	replace = 'replace',
	remove = 'remove'
}

interface ObjectPatch {
	op: PatchOperations,
	path: string,
	value: any
}

interface NexxusPatchConstructor {
	readonly prototype: NexxusPatch
	new(objectPatch: object): NexxusPatch
	new(objectPatch: object, applicationId: string): NexxusPatch

	op: PatchOperations
	path: string
	model: string
	id: string
	field: string
	value: any
	applicationId: string
}

interface NexxusPatch {
	applyPatches(patches: Array<NexxusPatch>, object: NexxusModel): NexxusModel
}

declare const NexxusPatchConstructor : NexxusPatchConstructor & NexxusPatch

export = NexxusPatchConstructor
