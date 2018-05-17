const async = require('async');
const redis = require('redis');
const fs = require('fs');
const path = require('path');
const Application = require('./lib/Application');
const ConfigurationManager = require('./lib/ConfigurationManager');
const Datasource = require('./lib/database/datasource');
const TelepatLogger = require('./lib/logger/logger');
const Services = require('./lib/Services');
const SystemMessageProcessor = require('./lib/systemMessage');
const Admin = require('./lib/Admin');
const Model = require('./lib/Model');
const Context = require('./lib/Context');
const TelepatError = require('./lib/TelepatError');
const User = require('./lib/User');
const Delta = require('./lib/Delta');
const Channel = require('./lib/Channel');
const Subscription = require('./lib/Subscription');

let config;
let acceptedServices = {
	ElasticSearch: require('./lib/database/elasticsearch_adapter')
};

fs.readdirSync(path.join(__dirname, '/lib/message_queue')).forEach(filename => {
	let filenameParts = filename.split('_');

	if (filenameParts.pop() === 'queue.js') {
		acceptedServices[filenameParts.join('_')] = require('./lib/message_queue/' + filename);
	}
});

const init = (servicesConfig, callback) => {
	let configManager = new ConfigurationManager('./config.spec.json', './config.json');
	let name = servicesConfig.name;

	async.series([
		seriesCallback => {
			configManager.load(err => {
				if (err) {
					return seriesCallback(err);
				}

				let testResult = configManager.test();

				if (testResult === true) {
					config = configManager.config;

					return seriesCallback();
				}

				return seriesCallback(testResult);
			});
		},
		seriesCallback => {
			if (config.logger) {
				config.logger.name = name;
				Services.logger = new TelepatLogger(config.logger);
			} else {
				Services.logger = new TelepatLogger({
					type: 'Console',
					name: name + (process.env.PORT || 3000),
					settings: { level: 'info' }
				});
			}
			let mainDatabase = config.main_database;

			if (!acceptedServices[mainDatabase]) {
				seriesCallback(new Error(`Unable to load "${mainDatabase}" main database: not found. Aborting...`, 2));
				process.exit(2);
			}

			Services.datasource = new Datasource();
			Services.datasource.setMainDatabase(new acceptedServices[mainDatabase](config[mainDatabase]));
			seriesCallback();
		},
		seriesCallback => {
			Services.datasource.dataStorage.onReady(seriesCallback);
		},
		seriesCallback => {
			if (Services.redisClient) {
				Services.redisClient = null;
			}

			let redisConf = config.redis;

			Services.redisClient = redis.createClient({
				port: redisConf.port,
				host: redisConf.host,
				retry_strategy: options => {
					if (options.error && (options.error.code === 'ETIMEDOUT' || options.error.code === 'ECONNREFUSED')) {
						return 1000;
					}

					Services.logger.error(`Redis server connection lost "${redisConf.host}". Retrying...`);
					// reconnect after

					return 3000;
				}
			});
			Services.redisClient.on('error', err => {
				Services.logger.error(`Failed connecting to Redis "${redisConf.host}": ${err.message}. Retrying...`);
			});
			Services.redisClient.on('ready', () => {
				Services.logger.info('Client connected to Redis.');
				seriesCallback();
			});
		},
		seriesCallback => {
			if (Services.redisCacheClient) {
				Services.redisCacheClient = null;
			}

			let redisCacheConf = config.redisCache;

			Services.redisCacheClient = redis.createClient({
				port: redisCacheConf.port,
				host: redisCacheConf.host,
				retry_strategy: options => {
					if (options.error && (options.error.code === 'ETIMEDOUT' || options.error.code === 'ECONNREFUSED')) {
						return 1000;
					}

					Services.logger.error(`Redis cache server connection lost "${redisCacheConf.host}". Retrying...`);

					// reconnect after
					return 3000;
				}
			});
			Services.redisCacheClient.on('error', err => {
				Services.logger.error(`Failed connecting to Redis Cache "${redisCacheConf.host}": ${err.message}. Retrying...`);
			});
			Services.redisCacheClient.on('ready', () => {
				Services.logger.info('Client connected to Redis Cache.');
				seriesCallback();
			});
		},
		seriesCallback => {
			let messagingClient = config.message_queue;
			let clientConfiguration = config[messagingClient];
			let type;

			if (!acceptedServices[messagingClient]) {
				return seriesCallback(new Error(`Unable to load "${messagingClient}" messaging queue: not found. Aborting...`, 5));
			}

			if (!clientConfiguration && servicesConfig) {
				clientConfiguration = { broadcast: servicesConfig.broadcast, exclusive: servicesConfig.exclusive };
			} else if (servicesConfig) {
				clientConfiguration.broadcast = servicesConfig.broadcast;
				clientConfiguration.exclusive = servicesConfig.exclusive;
				name = servicesConfig.name;
				type = servicesConfig.type;
			} else {
				clientConfiguration = clientConfiguration || { broadcast: false };
				type = name;
			}
			/**
			 * @type {MessagingClient}
			 */
			Services.messagingClient = new acceptedServices[messagingClient](clientConfiguration, name, type);

			Services.messagingClient.systemMessageFunc = (message, callback) => {
				SystemMessageProcessor.identity = name;

				if (message._systemMessage) {
					Services.logger.debug(`Got system message: "${JSON.stringify(message)}"`);
					SystemMessageProcessor.process(message);
				}

				callback(message);
			};

			return Services.messagingClient.onReady(seriesCallback);
		},
		seriesCallback => {
			module.exports.config = config;
			Application.getAll(seriesCallback);
		}
	], callback);
};

const appsModule = new Proxy({
	new: Application.new,
	get: Application.get,
	isBuiltInModel: Application.isBuiltInModel,
	models: Model,
	contexts: Context,
	users: User,
	getIterator: () => Application.apps
}, {
	get: (object, prop) => {
		if (!config) {
			throw new Error('Not initialized'); // TODO: improve
		}

		if (object[prop] instanceof Function) {
			return object[prop];
		}

		return object.get(prop);
	}
});

module.exports = {
	init,
	config,
	apps: appsModule,
	admins: Admin,
	error: error => new TelepatError(error),
	errors: TelepatError.errors,
	services: Services,
	TelepatError: TelepatError,
	users: User,
	contexts: Context,
	subscription: Subscription,
	models: Model,
	delta: Delta,
	channel: Channel,
	SystemMessageProcessor: SystemMessageProcessor,
	Application: Application,
	telepatIndexedList: require('./lib/TelepatIndexedLists')
};
