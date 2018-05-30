const EventEmitter = require('events');

/**
 * @typedef {Object} MessagingClientConfig
 * @prop {bool} exclusive
 * @prop {string} serviceName
 * @prop {string} serviceType
 * @prop {int} nodeIndex
 */

class MessagingClient extends EventEmitter {
	/**
	 * @param {MessagingClientConfig} config
	 */
	constructor (config) {
		super();

		/**
		 * @type {MessagingClientConfig}
		 * @instance
		 */
		this.config = config || {};
		this.config.exclusive = config.exclusive || false;
	}

	/**
	 * @abstract
	 * @param {string[]} messages
	 * @param {string} channel
	 */
	send (message, channel) {
		throw new Error('Unimplemented send function.');
	}

	/**
	 * @abstract
	 * @param message
	 * @param callback
	 */
	sendSystemMessages (message) {
		throw new Error('Unimplemented sendSystemMessages function.');
	}

	/**
	 * @abstract
	 * @param {string[]} messages
	 * @param {string} channel
	 */
	publish (message, channel) {
		throw new Error('Unimplemented publish function.');
	}

	shutdown () {
		throw new Error('Unimplemented shutdown function.');
	}
}

module.exports = MessagingClient;
