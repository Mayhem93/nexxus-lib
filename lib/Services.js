const Redis = require('redis'); // eslint-disable-line no-unused-vars

/**
 * @typedef {Object} TelepatServices
 * @prop {DataSource} datasource
 * @prop {TelepatLogger} logger
 * @prop {MessagingClient} messagingClient
 * @prop {Redis.RedisClient} redisCacheClient
 */

/**
 * @type {TelepatServices}
 */
const Services = {
	datasource: null,
	logger: null,
	messagingClient: null,
	redisCacheClient: null
};

module.exports = Services;
