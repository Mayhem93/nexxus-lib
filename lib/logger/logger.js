const NexxusError = require('../NexxusError');
const winston = require('winston');
const dateformat = require('dateformat');
const uuid = require('uuid');

const log = Symbol('log private method');

class NexxusLogger {
	constructor (options = {}) {
		if (!options.type) {
			this.options = {
				type: 'Console',
				name: options.serviceName || uuid.v4(),
				settings: {
					level: 'info'
				}
			};
		} else {
			this.options = options;
		}

		if (options.type !== 'Console') {
			try {
				// require(NexxusLogger.loggers[options.type])[options.type];
				winston.add(winston.transports[options.type], options.settings);
				winston.remove(winston.transports.Console);
			} catch (e) {
				console.log(`Could not load winston logger: ${e}`);
			}
		}

		winston.setLevels(winston.config.syslog.levels);
		winston.level = options.settings.level || 'info';
	}

	[log] (level, message) {
		let timestamp = dateformat(new Date(), 'yyyy-mm-dd HH:MM:ss.l');

		winston.log(level, `[${timestamp}][${this.options.serviceName}] ${message instanceof NexxusError ? message.message : message}`);
	}

	debug (message) {
		this[log]('debug', message);
	}

	info (message) {
		this[log]('info', message);
	}

	notice (message) {
		this[log]('notice', message);
	}

	warning (message) {
		this[log]('warn', message);
	}

	error (message) {
		this[log]('error', message);
	}

	critical (message) {
		this[log]('crit', message);
	}

	alert (message) {
		this[log]('alert', message);
	}

	emergency (message) {
		this[log]('emerg', message);
	}
}

module.exports = NexxusLogger;
