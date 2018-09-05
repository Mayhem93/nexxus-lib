const Redis = require('redis');
const fs = require('fs');
const path = require('path');
const NexxusApplication = require('./lib/Application');
const ConfigurationManager = require('./lib/ConfigurationManager');
const Datasource = require('./lib/database/datasource');
const NexxusLogger = require('./lib/logger/logger');
const SystemMessageProcessor = require('./lib/systemMessage');
const NexxusAdmin = require('./lib/Admin');
const NexxusContext = require('./lib/Context');
const NexxusError = require('./lib/NexxusError');
const NexxusUser = require('./lib/User');
const NexxusDelta = require('./lib/Delta');
const NexxusChannel = require('./lib/Channel');
const NexxusSubscription = require('./lib/Subscription');
const NexxusModel = require('./lib/Model');
const FilterBuilder = require('./utils/filterbuilder');
const Services = require('./lib/Services');
const NexxusDevice = require('./lib/Device');
const constants = require('./lib/constants');

let config;
const acceptedServices = {};

fs.readdirSync(path.join(__dirname, '/lib/database/adapters')).forEach(filename => {
	let filenameParts = filename.split('_');

	if (filenameParts.pop() === 'adapter.js') {
		acceptedServices[filenameParts[0]] = require(`./lib/database/adapters/${filename}`);
	}
});

fs.readdirSync(path.join(__dirname, '/lib/message_queue/adapters')).forEach(filename => {
	let filenameParts = filename.split('_');

	if (filenameParts.pop() === 'queue.js') {
		acceptedServices[filenameParts[0]] = require(`./lib/message_queue/adapters/${filename}`);
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

	let messagingClient = config.message_queue;

	if (!acceptedServices[messagingClient]) {
		throw new NexxusError(NexxusError.errors.ServerFailure, `Unable to load "${messagingClient}" messaging queue: not found. Aborting...`);
	}

	let clientConfiguration = Object.assign(config[messagingClient], {
		serviceType,
		serviceName,
		nodeIndex
	});

	Services.messagingClient = new acceptedServices[messagingClient](clientConfiguration);

	await (new Promise(resolve => {
		Services.messagingClient.on('ready', () => {
			Services.logger.info('Messaging services connected');
			resolve();
		});
	}));

	await NexxusApplication.getAll();
};

module.exports = {
	init,
	config,
	constants,
	Services,
	NexxusApplication,
	NexxusAdmin,
	NexxusError,
	NexxusUser,
	NexxusContext,
	NexxusSubscription,
	NexxusDevice,
	NexxusModel,
	NexxusDelta,
	NexxusChannel,
	FilterBuilder,
	SystemMessageProcessor
};
