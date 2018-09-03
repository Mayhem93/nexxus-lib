const async = require('async');
const utils = require('../utils/utils');
const NexxusError = require('./NexxusError');
const objectMerge = require('object-merge');
const Services = require('./Services');
const constants = require('./constants');
const promisify = require('util').promisify;

class Subscription {
	static getSubscribedDevices (channel) {
		return promisify(Services.redisClient.smembers)(channel.get());
	}

	static async add (applicationId, deviceId, channel) {
		let deviceSubscriptionsKey = `${constants.CHANNEL_KEY_PREFIX}:${applicationId}:device:${deviceId}:subscriptions`;
		let device = await promisify(Subscription.getDevice)(applicationId, deviceId);

		let transportType = '';
		let token = '';

		if (device.volatile && device.volatile.active) {
			transportType = device.volatile.server_name;
			token = device.volatile.token;

			if (!transportType || !token) {
				throw new NexxusError(NexxusError.errors.DeviceInvalid, [deviceId, 'volatile server_name or token is missing']);
			}
		} else {
			if (!device.persistent || !device.persistent.type || !device.persistent.token) {
				throw new NexxusError(NexxusError.errors.DeviceInvalid, [deviceId, 'persistent type and/or token is missing']);
			}

			transportType = `${device.persistent.type}_transport`;
			token = device.persistent.token;
		}

		await promisify(Services.redisClient.sadd)([channel.get(), `${transportType}|${deviceId}|${token}|${applicationId}`]);
		await promisify(Services.redisClient.sadd)([deviceSubscriptionsKey, channel.get()]);
	}

	static async addDevice (device) {
		const key = `${constants.CHANNEL_KEY_PREFIX}:${device.application_id}:devices:${device.id}`;

		if (device.info && device.info.udid) {
			const udidKey = `${constants.CHANNEL_KEY_PREFIX}:${device.application_id}:devices:udid:${device.info.udid}`;

			await promisify(Services.redisClient.set)(udidKey, device.id);
		}

		await promisify(Services.redisClient.set)(key, JSON.stringify(device));
	}

	static async remove (appId, deviceId, channel, token = null) {
		if (typeof channel !== 'string')	{
			channel = channel.get();
		}

		const device = await promisify(Subscription.getDevice)(appId, deviceId);
		const deviceSubscriptionsKey = `${constants.CHANNEL_KEY_PREFIX}:${appId}:device:${deviceId}:subscriptions`;

		await promisify(Services.redisClient.srem)([deviceSubscriptionsKey, channel]);

		let transportType = '';

		if (!token) {
			if (device.volatile && device.volatile.active) {
				token = device.volatile.token;
			} else {
				token = device.persistent.token;
			}
		}

		if (device.volatile && device.volatile.active) {
			transportType = device.volatile.server_name;
		} else {
			transportType = `${device.persistent.type}_transport`;
		}

		const removed = await promisify(Services.redisClient.srem)([channel, `${transportType}|${deviceId}|${token}|${appId}`]);

		if (removed === 0) {
			throw new NexxusError(NexxusError.errors.SubscriptionNotFound);
		}
	}

	static async removeAllSubscriptionsFromDevice (applicationId, deviceId, token, transport) {
		if (!transport || typeof transport !== 'string') {
			throw new NexxusError(NexxusError.errors.UnspecifiedError, ['removeAllSubscriptionsFromDevice: need to specify transport']);
		}

		const subscriptions = await Subscription.getDeviceSubscriptions(applicationId, deviceId);

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

	static async getDevice (appId, id) {
		const key = `${constants.CHANNEL_KEY_PREFIX}:${appId}:devices:${id}`;
		const result = await promisify(Services.redisClient.get)(key);

		if (result === null) {
			throw new NexxusError(NexxusError.errors.DeviceNotFound, [id]);
		}

		return JSON.parse(result);
	}

	static getDeviceSubscriptions (applicationId, deviceId) {
		const deviceSubscriptionsKey = `${constants.CHANNEL_KEY_PREFIX}:${applicationId}:device:${deviceId}:subscriptions`;

		return promisify(Services.redisClient.smembers)([deviceSubscriptionsKey]);
	}

	static async removeDevice (applicationId, id) {
		const keys = [`${constants.CHANNEL_KEY_PREFIX}:${applicationId}:devices:${id}`];

		keys.push(`${constants.CHANNEL_KEY_PREFIX}:${applicationId}:device:${id}:subscriptions`);

		const result = await promisify(Services.redisClient.del)(keys);

		if (result === null || result === 0) {
			throw new NexxusError(NexxusError.errors.DeviceNotFound, [id]);
		}
	}

	static findDeviceByUdid (applicationId, udid) {
		let udidkey = `${constants.CHANNEL_KEY_PREFIX}:${applicationId}:devices:udid:${udid}`;

		return promisify(Services.redisClient.get)(udidkey);
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

	static async updateDevice (applicationId, device, props) {
		const key = `${constants.CHANNEL_KEY_PREFIX}:${applicationId}:devices:${device}`;
		const newDevice = objectMerge(await Subscription.getDevice(applicationId, device), props);

		return promisify(Services.redisClient.set)([key, JSON.stringify(newDevice), 'XX']);
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

module.exports = Subscription;
