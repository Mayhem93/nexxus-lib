import TelepatError = require('../TelepatError');

type LOG_LEVEL = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

export declare class TelepatLogger {
	constructor(options?: object);
	private log(level: LOG_LEVEL, message: string|TelepatError)
	debug(message: string|TelepatError);
	info(message: string | TelepatError);
	notice(message: string | TelepatError);
	warning(message: string | TelepatError);
	error(message: string | TelepatError);
	critical(message: string | TelepatError);
	alert(message: string | TelepatError);
	emergency(message: string | TelepatError);
}
