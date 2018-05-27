const EventEmitter = require('events');

class MessagingClient extends EventEmitter {
	constructor (config, name, channel) {
		super();

		this.broadcast = !!config.broadcast;
		delete config.broadcast;

		this.config = config || {};
		this.channel = config.exclusive ? name : channel;
		this.name = name;
		this.connectionClient = null;
	}
	/**
	 * @callback onMessageCb
	 * @param {string} data
	 */
	/**
	 * @abstract
	 * @param {onMessageCb} callback
	 */
	/* 	onMessage (callback) {
		throw new Error('Unimplemented onMessage function.');
	}

	onReady (callback) {
		this.onReadyFunc = callback;
	} */

	/**
	 * @abstract
	 * @param {string[]} messages
	 * @param {string} channel
	 * @param callback
	 */
	send (message, channel, callback) {
		throw new Error('Unimplemented send function.');
	}

	/**
	 * @abstract
	 * @param message
	 * @param callback
	 */
	sendSystemMessages (message, callback) {
		throw new Error('Unimplemented sendSystemMessages function.');
	}

	/**
	 * @abstract
	 * @param {string[]} messages
	 * @param {string} channel
	 * @param callback
	 */
	publish (message, channel, callback) {
		throw new Error('Unimplemented publish function.');
	}

	shutdown (callback) {
		throw new Error('Unimplemented shutdown function.');
	}

	/* on (event, callback) {
		if (this.connectionClient.on instanceof Function) {
			this.connectionClient.on(event, callback);
		}
	} */
}

module.exports = MessagingClient;
