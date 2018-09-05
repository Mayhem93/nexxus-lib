const constants = require('./constants');
const NexxusError = require('./NexxusError');
const Services = require('./Services');
const NexxusSubscription = require('./Subscription');
const objectMerge = require('object-merge');
const promisify = require('util').promisify;

async function removeDevice (applicationId, id) {
	const keys = [`${constants.CHANNEL_KEY_PREFIX}:${applicationId}:devices:${id}`];

	keys.push(`${constants.CHANNEL_KEY_PREFIX}:${applicationId}:device:${id}:subscriptions`);

	const result = await promisify(Services.redisClient.del)(keys);

	if (result === null || result === 0) {
		throw new NexxusError(NexxusError.errors.DeviceNotFound, [id]);
	}
}

async function getSubscriptions (applicationId, deviceId) {
	const deviceSubscriptionsKey = `${constants.CHANNEL_KEY_PREFIX}:${applicationId}:device:${deviceId}:subscriptions`;
	const subscriptions = (await promisify(Services.redisClient.smembers)([deviceSubscriptionsKey])).map(channel => {
		return new NexxusSubscription(channel);
	});

	return subscriptions;
}

class NexxusDevice {
	constructor (applicationId, properties) {
		this.props = { applicationId };
		Object.assign(this.props, properties);
	}

	getToken () {
		if (this.props.volatile && this.props.volatile.active) {
			return this.props.volatile.token;
		}

		return this.props.persistent.token;
	}

	getTransportType () {
		if (this.props.volatile && this.props.volatile.active) {
			return this.props.volatile.server_name;
		}

		return `${this.props.persistent.type}_transport`;
	}

	async getSubscriptions () {
		const subs = await getSubscriptions(this.props.applicationId, this.props.id);

		this.subscriptions = subs;

		return subs;
	}

	async addSubscription (channel) {
		let subscription = new NexxusSubscription(channel);
		let deviceSubscriptionsKey = `${constants.CHANNEL_KEY_PREFIX}:${this.props.applicationId}:device:${this.props.id}:subscriptions`;

		let transportType = '';
		let token = '';

		if (this.props.volatile && this.props.volatile.active) {
			transportType = this.props.volatile.server_name;
			token = this.props.volatile.token;

			if (!transportType || !token) {
				throw new NexxusError(NexxusError.errors.DeviceInvalid, [this.props.id, 'volatile server_name or token is missing']);
			}
		} else {
			if (!this.props.persistent || !this.props.persistent.type || !this.props.persistent.token) {
				throw new NexxusError(NexxusError.errors.DeviceInvalid, [this.props.id, 'persistent type and/or token is missing']);
			}

			transportType = `${this.props.persistent.type}_transport`;
			token = this.props.persistent.token;
		}

		await promisify(Services.redisClient.sadd)([subscription.getChannel(), `${transportType}|${this.props.id}|${token}|${this.props.applicationId}`]);
		await promisify(Services.redisClient.sadd)([deviceSubscriptionsKey, subscription.getChannel()]);

		this.subscriptions.push(subscription);
	}

	async removeSubscription (subscription, token = null) {
		const deviceSubscriptionsKey = `${constants.CHANNEL_KEY_PREFIX}:${this.props.applicationId}:device:${this.props.id}:subscriptions`;

		await promisify(Services.redisClient.srem)([deviceSubscriptionsKey, subscription.getChannel()]);

		let transportType = this.getTransportType();

		token = token || this.getToken();

		const removed = await promisify(Services.redisClient.srem)([subscription.getChannel(), `${transportType}|${this.props.id}|${token}|${this.props.applicationId}`]);

		if (removed === 0) {
			throw new NexxusError(NexxusError.errors.SubscriptionNotFound);
		}
	}

	async update (props) {
		const key = `${constants.CHANNEL_KEY_PREFIX}:${this.applicationId}:devices:${this.id}`;
		const newDevice = objectMerge(this, props);

		await promisify(Services.redisClient.set)([key, JSON.stringify(newDevice), 'XX']);

		Object.assign(this, newDevice);
	}

	remove () {
		return removeDevice(this.props.applicationId, this.props.id);
	}

	static async create (properties) {
		const key = `${constants.CHANNEL_KEY_PREFIX}:${properties.application_id}:devices:${properties.id}`;

		if (properties.info && properties.info.udid) {
			const udidKey = `${constants.CHANNEL_KEY_PREFIX}:${properties.application_id}:devices:udid:${properties.info.udid}`;

			await promisify(Services.redisClient.set)(udidKey, properties.id);
		}

		await promisify(Services.redisClient.set)(key, JSON.stringify(properties));

		return new NexxusDevice(properties);
	}

	static async get (applicationId, id) {
		const key = `${constants.CHANNEL_KEY_PREFIX}:${applicationId}:devices:${id}`;
		const result = await promisify(Services.redisClient.get)(key);

		if (result === null) {
			throw new NexxusError(NexxusError.errors.DeviceNotFound, [id]);
		}

		return new NexxusDevice(applicationId, JSON.parse(result));
	}

	static getByUdid (applicationId, udid) {
		let udidkey = `${constants.CHANNEL_KEY_PREFIX}:${applicationId}:devices:udid:${udid}`;

		return NexxusDevice.get(applicationId, promisify(Services.redisClient.get)(udidkey));
	}

	static removeById (applicationId, id) {
		return removeDevice(applicationId, id);
	}

	static async updateById (applicationId, id, props) {
		const key = `${constants.CHANNEL_KEY_PREFIX}:${applicationId}:devices:${id}`;
		const newDevice = objectMerge(await NexxusDevice.getDevice(applicationId, id), props);

		await promisify(Services.redisClient.set)([key, JSON.stringify(newDevice), 'XX']);

		return new NexxusDevice(applicationId, newDevice);
	}

	static getSubscriptionsByDevice (applicationId, deviceId) {
		return getSubscriptions(applicationId, deviceId);
	}
}

module.exports = NexxusDevice;
