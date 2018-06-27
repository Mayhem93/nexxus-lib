import NexxusError = require('./NexxusError');

declare class NexxusErrorCollection extends NexxusError {
	readonly test: Array<NexxusError>
	constructor(errorCollection: Array<NexxusError>)
}

export = NexxusErrorCollection
