const Redis = require('redis');
const fs = require('fs');
const path = require('path');
const Application = require('./lib/Application');
const ConfigurationManager = require('./lib/ConfigurationManager');
const Datasource = require('./lib/database/datasource');
const TelepatLogger = require('./lib/logger/logger');
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

const Services = {
	datasource: null,
	logger: null,
	messagingClient: null,
	redisCacheClient: null
};

fs.readdirSync(path.join(__dirname, '/lib/message_queue')).forEach(filename => {
	let filenameParts = filename.split('_');

	if (filenameParts.pop() === 'queue.js') {
		acceptedServices[filenameParts.join('_')] = require(`./lib/message_queue/${filename}`)(Services);
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
	Services.logger = new TelepatLogger(Object.assign(config.logger, { serviceName }));

	let mainDatabase = config.main_database;

	if (!acceptedServices[mainDatabase]) {
		throw new TelepatError(TelepatError.errors.ServerFailure, `Unable to load "${mainDatabase}" main database: not found. Aborting...`);
	}

	Services.datasource = new Datasource();
	Services.datasource.setMainDatabase(new acceptedServices[mainDatabase](config[mainDatabase]));
	await (new Promise((resolve, reject) => {
		Services.datasource.dataStorage.on('ready', err => err ? reject(err) : resolve());
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

	Services.datasource.cacheDatabase.on('error', err => {
		Services.logger.error(`Failed connecting to Redis "${redisConf.host}": ${err.message}. Retrying...`);
	});

	await (new Promise(resolve => {
		Services.datasource.cacheDatabase.on('ready', () => {
			Services.logger.info('Client connected to Redis.');
			resolve();
		});
	}));

	let redisCacheConf = config.redisCache;

	Services.redisCacheClient = Redis.createClient({
		port: redisCacheConf.port,
		host: redisCacheConf.host,
		retry_strategy: retryStrategy
	});

	Services.redisCacheClient.on('error', err => {
		Services.logger.error(`Failed connecting to Redis Cache "${redisCacheConf.host}": ${err.message}. Retrying...`);
	});

	await (new Promise(resolve => {
		Services.redisCacheClient.on('ready', () => {
			Services.logger.info('Client connected to Redis.');
			resolve();
		});
	}));

	let messagingClient = config.message_queue;

	if (!acceptedServices[messagingClient]) {
		throw new TelepatError(TelepatError.errors.ServerFailure, `Unable to load "${messagingClient}" messaging queue: not found. Aborting...`);
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

	await Application.getAll();
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
	// error: error => new TelepatError(error),
	errors: TelepatError.errors,
	TelepatError,
	users: User,
	contexts: Context,
	subscription: Subscription,
	models: Model,
	delta: Delta,
	channel: Channel,
	SystemMessageProcessor,
	Application,
	telepatIndexedList: require('./lib/TelepatIndexedLists')
};
