const NexxusError = require('./NexxusError');
const Services = require('./Services');
const NexxusDevice = require('./Device');
const promisify = require('util').promisify;
const constants = require('./constants');

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
	static async getAllDevices (applicationId) {
		const deviceIds = await promisify(Services.datasource.cacheStorage.smembers)(`${constants.CHANNEL_KEY_PREFIX}:${applicationId}:devices`);
		const deviceObjects = await promisify(Services.datasource.cacheStorage.mget)(deviceIds);
		const devices = new Map();

		deviceObjects.forEach(deviceObj => {
			let parsedDevice = new NexxusDevice(JSON.parse(deviceObj));

			if (parsedDevice.isVolatileTransportActive()) {
				if (!devices.has(parsedDevice.props.volatile.server_name)) {
					devices.set(parsedDevice.volatile.server_name, [`${parsedDevice.id}|${parsedDevice.volatile.token}`]);
				} else {
					devices.get(parsedDevice.volatile.server_name).push(`${parsedDevice.id}|${parsedDevice.volatile.token}`);
				}
			} else if (parsedDevice.hasPersistentTransport()) {
				let queueName = parsedDevice.getTransportType();

				if (!devices.has(queueName)) {
					devices.set(queueName, [`${parsedDevice.id}|${parsedDevice.persistent.token}`]);
				} else {
					devices.get(queueName).push(`${parsedDevice.id}|${parsedDevice.persistent.token}`);
				}
			}
		});

		return devices;
	}

	static async getSubscriptionKeysWithFilters (channel) {
		// todo: refactor getting subscriptions with filters as to avoid scanning
		return (await promisify(Services.datasource.cacheStorage.smembers)(`${channel.get()}:filters`)).map(filterKey => {
			let lastKeyPart = filterKey.split(':').pop();

			// the base64 encoded filter object is at the end of the key name, after ':filter:'
			let queryObject = JSON.parse((Buffer.from(lastKeyPart, 'base64')).toString('utf-8'));

			return channel.clone().setFilter(queryObject);
		});
	}
}

module.exports = NexxusSubscription;
