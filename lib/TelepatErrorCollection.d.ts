import {TelepatError} from './TelepatError';

declare class TelepatErrorCollection extends TelepatError {
	constructor(errorCollection: Array<TelepatError>)
}
