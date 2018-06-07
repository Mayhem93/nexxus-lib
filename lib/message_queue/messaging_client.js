const EventEmitter = require('events');

class MessagingClient extends EventEmitter {
	constructor (config) {
		super();

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
	sendSystemMessages (to, action, message) {
		throw new Error('Unimplemented sendSystemMessages function.');
	}

	/**
	 * @abstract
	 * @param {string[]} messages
	 * @param {string} channel
	 */
	publish (messages, channel) {
		throw new Error('Unimplemented publish function.');
	}

	shutdown () {
		throw new Error('Unimplemented shutdown function.');
	}
}

module.exports = MessagingClient;
