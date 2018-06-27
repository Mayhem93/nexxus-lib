const Redis = require('redis');
const fs = require('fs');
const path = require('path');
const Application = require('./lib/Application');
const ConfigurationManager = require('./lib/ConfigurationManager');
const Datasource = require('./lib/database/datasource');
const NexxusLogger = require('./lib/logger/logger');
const SystemMessageProcessor = require('./lib/systemMessage');
const Admin = require('./lib/Admin');
const Context = require('./lib/Context');
const NexxusError = require('./lib/NexxusLogger');
const User = require('./lib/User');
const Delta = require('./lib/Delta');
const Channel = require('./lib/Channel');
const Subscription = require('./lib/Subscription');
const Model = require('./lib/Model');
const FilterBuilder = require('./utils/filterbuilder');
const Services = require('./lib/Services');

let config;
const acceptedServices = {};

fs.readdirSync(path.join(__dirname, '/lib/database/adapters')).forEach(filename => {
	let filenameParts = filename.split('_');

	if (filenameParts.pop() === 'adapter.js') {
		acceptedServices[filenameParts.join('_')] = require(`./lib/database/adapters/${filename}`);
	}
});

fs.readdirSync(path.join(__dirname, '/lib/message_queue/adapters')).forEach(filename => {
	let filenameParts = filename.split('_');

	if (filenameParts.pop() === 'queue.js') {
		acceptedServices[filenameParts.join('_')] = require(`./lib/message_queue/adapters/${filename}`);
	}
});

const init = async serviceOptions => {
	const serviceType = serviceOptions.serviceType;
	const nodeIndex = serviceOptions.nodeIndex;
	const serviceName = `${serviceType}-${nodeIndex}`;
	const configManager = new ConfigurationManager(serviceOptions.configFileSpec, serviceOptions.configFile);

	await configManager.load();
	configManager.test();
	config = configManager.config;

	Services.logger = new NexxusLogger(Object.assign(config.logger, { serviceName }));

	let mainDatabase = config.main_database;

	if (!acceptedServices[mainDatabase]) {
		throw new NexxusError(NexxusError.errors.ServerFailure, `Unable to load "${mainDatabase}" main database: not found. Aborting...`);
	}

	Services.datasource = new Datasource();
	Services.datasource.setMainDatabase(new acceptedServices[mainDatabase](config[mainDatabase]));
	await (new Promise((resolve, reject) => {
		Services.datasource.dataStorage.on('ready', resolve);
		Services.datasource.dataStorage.on('error', reject);
	}));

	let redisConf = config.redis;

	const retryStrategy = options => {
		if (options.error && (options.error.code === 'ETIMEDOUT' || options.error.code === 'ECONNREFUSED')) {
			return 1000;
		}

		Services.logger.error(`Redis server connection lost "${redisConf.host}". Retrying...`);
		// reconnect after

		return 3000;
	};

	Services.datasource.setCacheDatabase(Redis.createClient({
		port: redisConf.port,
		host: redisConf.host,
		retry_strategy: retryStrategy
	}));

	Services.datasource.cacheStorage.on('error', err => {
		Services.logger.error(`Failed connecting to Redis "${redisConf.host}": ${err.message}. Retrying...`);
	});

	await (new Promise(resolve => {
		Services.datasource.cacheStorage.on('ready', () => {
			Services.logger.info('Client connected to Redis.');
			resolve();
		});
	}));

	let redisCacheConf = config.redisCache;

	Services.redisClient = Redis.createClient({
		port: redisCacheConf.port,
		host: redisCacheConf.host,
		retry_strategy: retryStrategy
	});

	Services.redisClient.on('error', err => {
		Services.logger.error(`Failed connecting to Redis Cache "${redisCacheConf.host}": ${err.message}. Retrying...`);
	});

	await (new Promise(resolve => {
		Services.redisClient.on('ready', () => {
			Services.logger.info('Client connected to Redis.');
			resolve();
		});
	}));

	let messagingClient = config.message_queue;

	if (!acceptedServices[messagingClient]) {
		throw new NexxusError(NexxusError.errors.ServerFailure, `Unable to load "${messagingClient}" messaging queue: not found. Aborting...`);
	}

	let clientConfiguration = Object.assign(config[messagingClient], {
		serviceType,
		serviceName,
		nodeIndex
	});

	messagingClient = new acceptedServices[messagingClient](clientConfiguration);

	await (new Promise(resolve => {
		messagingClient.on('ready', () => {
			Services.logger.info('Messaging services connected');
			resolve();
		});
	}));

	await Application.getAll();
};

/* const appsModule = new Proxy(Application, {
	get: (object, prop) => {
		if (object[prop] instanceof Function) {
			return object[prop];
		}

		return object.get(prop);
	}
}); */

module.exports = {
	init,
	config,
	logger: Services.logger,
	messagingClient: Services.messagingClient,
	Application,
	Admin,
	NexxusError,
	User,
	Context,
	Subscription,
	Model,
	Delta,
	Channel,
	FilterBuilder,
	SystemMessageProcessor
};
