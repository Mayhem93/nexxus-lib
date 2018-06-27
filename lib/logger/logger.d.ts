import NexxusError = require('../NexxusError');

type LOG_LEVEL = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

export declare class NexxusLogger {
	constructor(options?: object);
	private log(level: LOG_LEVEL, message: string | NexxusError)
	debug(message: string| NexxusError);
	info(message: string | NexxusError);
	notice(message: string | NexxusError);
	warning(message: string | NexxusError);
	error(message: string | NexxusError);
	critical(message: string | NexxusError);
	alert(message: string | NexxusError);
	emergency(message: string | NexxusError);
}
