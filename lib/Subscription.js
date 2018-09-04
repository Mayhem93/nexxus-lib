const async = require('async');
const utils = require('../utils/utils');
const NexxusError = require('./NexxusError');
const Services = require('./Services');
const NexxusDevice = require('./Device');
const promisify = require('util').promisify;

class NexxusSubscription {
	constructor (channel) {
		this.channel = channel;
	}

	getChannel () {
		return this.channel.get();
	}

	static async removeAllSubscriptionsFromDevice (applicationId, deviceId, token, transport) {
		if (!transport || typeof transport !== 'string') {
			throw new NexxusError(NexxusError.errors.UnspecifiedError, ['removeAllSubscriptionsFromDevice: need to specify transport']);
		}

		const subscriptions = await NexxusDevice.getSubscriptionsByDevice(applicationId, deviceId);

		if (!subscriptions.length) {
			return null;
		}

		const transaction = Services.redisClient.multi();

		subscriptions.forEach(subscription => {
			transaction.srem([subscription, `${transport}|${deviceId}|${token}|${applicationId}`]);
		});

		await promisify(transaction.exec)();

		return subscriptions;
	}

	/**
     * Gets all the devices.
     * @param callback
     */
	static getAllDevices (applicationId, callback) {
		// todo: refactor so to avoid using scan

		utils.scanRedisKeysPattern(`blg:${applicationId}:devices:[^udid]*`, Services.redisClient, (err, results) => {
			if (err) {
				return callback(err);
			}

			return Services.redisClient.mget(results, (err, results) => {
				if (err) {
					return callback(err);
				}

				let devices = {};

				return async.each(results, (result, c) => {
					if (result) {
						let parsedDevice = JSON.parse(result);

						if (parsedDevice.volatile && parsedDevice.volatile.active) {
							if (!devices[parsedDevice.volatile.server_name]) {
								devices[parsedDevice.volatile.server_name] = [`${parsedDevice.id}|${parsedDevice.volatile.token}`];
							} else {
								devices[parsedDevice.volatile.server_name].push(`${parsedDevice.id}|${parsedDevice.volatile.token}`);
							}
						} else if (parsedDevice.persistent) {
							let queueName = `${parsedDevice.persistent.type}_transport`;

							if (!devices[queueName]) {
								devices[queueName] = [`${parsedDevice.id}|${parsedDevice.persistent.token}`];
							} else {
								devices[queueName].push(`${parsedDevice.id}|${parsedDevice.persistent.token}`);
							}
						}
					}
					c();
				}, () => {
					callback(null, devices);
				});
			});
		});
	}

	static getSubscriptionKeysWithFilters (channel, callback) {
		// todo: refactor getting subscriptions with filters as to avoid scanning
		let filterChannels = [];

		utils.scanRedisKeysPattern(`${channel.get()}:filter:*[^:count_cache:LOCK]`, Services.redisClient, (err, results) => {
			if (err) {
				return callback(err);
			}

			for (let k in results) {
				// last part of the key is the base64-encoded filter object
				let lastKeyPart = results[k].split(':').pop();

				// the base64 encoded filter object is at the end of the key name, after ':filter:'
				let queryObject = JSON.parse((Buffer.from(lastKeyPart, 'base64')).toString('utf-8'));

				filterChannels.push(channel.clone().setFilter(queryObject));
			}

			return callback(null, filterChannels);
		});
	}
}

module.exports = NexxusSubscription;
