const TelepatError = require('../TelepatError');
const winston = require('winston');
const dateformat = require('dateformat');
const uuid = require('uuid');

class TelepatLogger {
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
				// require(TelepatLogger.loggers[options.type])[options.type];
				winston.add(winston.transports[options.type], options.settings);
				winston.remove(winston.transports.Console);
			} catch (e) {
				console.log(`Could not load winston logger: ${e}`);
			}
		}

		winston.setLevels(winston.config.syslog.levels);
		winston.level = options.settings.level || 'info';
	}

	/**
     *
     * @param {string} level
     * @param {string|TelepatError} message
     */
	log (level, message) {
		let timestamp = dateformat(new Date(), 'yyyy-mm-dd HH:MM:ss.l');

		winston.log(level, `[${timestamp}][${this.options.serviceName}] ${message instanceof TelepatError ? message.message : message}`);
	}

	/**
     *
     * @param {string|TelepatError} message
     */
	debug (message) {
		this.log('debug', message);
	}

	/**
     *
     * @param {string|TelepatError} message
     */
	info (message) {
		this.log('info', message);
	}

	/**
     *
     * @param {string|TelepatError} message
     */
	notice (message) {
		this.log('notice', message);
	}

	/**
     *
     * @param {string|TelepatError} message
     */
	warning (message) {
		this.log('warn', message);
	}

	/**
     *
     * @param {string|TelepatError} message
     */
	error (message) {
		this.log('error', message);
	}

	/**
     *
     * @param {string|TelepatError} message
     */
	critical (message) {
		this.log('crit', message);
	}

	/**
     *
     * @param {string|TelepatError} message
     */
	alert (message) {
		this.log('alert', message);
	}

	/**
     *
     * @param {string|TelepatError} message
     */
	emergency (message) {
		this.log('emerg', message);
	}
}
module.exports = TelepatLogger;
