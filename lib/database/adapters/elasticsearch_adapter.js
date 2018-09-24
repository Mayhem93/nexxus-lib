const MainDatabase = require('../mainDatabase.js');
const elasticsearch = require('elasticsearch');
const AgentKeepAlive = require('agentkeepalive');
const cloneObject = require('clone');
const async = require('async');
const {BuilderNode} = require('../../../utils/filterbuilder');
const NexxusError = require('../../NexxusError');
const Services = require('../../Services');
const constants = require('../../constants');
const NexxusPatch = require('../../Patch');
const utils = require('../../../utils/utils');

const tryConnectionMethod = Symbol('try connection private method');
const processSchemaModificationMethod = Symbol('process schema modification method');

class ElasticSearchDB extends MainDatabase {
	constructor (config) {
		if (typeof config !== 'object' || Object.keys(config).length === 0) {
			throw new NexxusError(NexxusError.errors.ServerFailure, ['supplied empty or invalid configuration parameter']);
		}

		let esConfig = {
			maxRetries: 10,
			deadTimeout: 1e4,
			pingTimeout: 3000,
			keepAlive: true,
			maxSockets: 300,
			createNodeAgent (connection, config) {
				return new AgentKeepAlive(connection.makeAgentConfig(config));
			}
		};

		if (config.hosts) {
			esConfig.hosts = config.hosts;
		} else if (config.host) {
			esConfig.host = config.host;
			esConfig.sniffOnStart = true;
			esConfig.sniffInterval = 30000;
			esConfig.sniffOnConnectionFault = true;
		}

		const esApi = elasticsearch.Client.apis._default;
		const disconnectFunctionHandler = e => {
			if (e.message === 'No Living connections' && !this.reconnecting) {
				this.reconnecting = true;
				Services.logger.emergency(`Lost connection to elasticsearch: ${e.message}`);

				setTimeout(() => {
					this[tryConnectionMethod]();
				}, 2000);

				this.emit('disconnect');
			}

			throw e;
		};

		for (const func in esApi) {
			if (esApi[func] && esApi[func].name === 'action') {
				esApi[func] = new Proxy(esApi[func], {
					apply: (target, ctx, args) => {
						// this will replace the original callback
						// when something bad happens normal operations are disrupted, thus we also emit a disconnected event
						// so the application knows something went wrong
						const lastArg = args.pop();

						// also the ES library supports both callback and promises
						if (lastArg instanceof Function) {
							args.push((err, res) => {
								if (err) {
									if (err.message.startsWith('Request Timeout')) {
										this.connected = false;
										this.reconnecting = true;

										return lastArg(err);
									}

									return disconnectFunctionHandler(err);
								}

								return lastArg(null, res);
							});

							return Reflect.apply(target, ctx, args);
						}

						args.push(lastArg);

						return Reflect.apply(target, ctx, args).catch(disconnectFunctionHandler);
					}
				});
			}
		}

		super(new elasticsearch.Client(esConfig));

		this.config = config;
		this.config.subscribe_limit = this.config.subscribe_limit || 64;
		this.config.get_limit = this.config.get_limit || 384;
		this.connected = false;
		this.reconnecting = false;

		this[tryConnectionMethod]();
	}

	[tryConnectionMethod] () {
		let error = false;

		async.doWhilst(callback => {
			this.connection.ping({}, (err, res) => {
				if (!err) {
					Services.logger.info('Connected to ElasticSearch MainDatabase');
					this.connected = true;

					return setImmediate(callback);
				}

				if (err.message === 'No Living connections') {
					Services.logger.error(`Failed connecting to Elasticsearch "${this.config.host || this.config.hosts.join(', ')}": ${err.message}. Retrying...`);
					setTimeout(callback, 2000);
				} else if (err.message.startsWith('Request Timeout')) {
					Services.logger.error(`Failed connecting to Elasticsearch "${this.config.host || this.config.hosts.join(', ')}": ${err.message}. Retrying...`);
					setTimeout(callback, 2000);
				} else {
					error = err;
					Services.logger.emergency(`Connection to ElasticSearch failed: ${err.message}`);
					setImmediate(callback);
				}

				return null;
			});
		}, () => this.connected === false && error === false, () => {
			if (error) {
				this.emit('error', error);
			} else {
				if (this.reconnecting === true) {
					this.emit('reconnected');
				} else {
					this.emit('ready');
				}

				this.reconnecting = false;
			}
		});
	}

	async [processSchemaModificationMethod] (applicationId, modifications) {
		if (modifications.added.schema) {
			const addedModels = Object.keys(modifications.added.schema);

			await addedModels.reduce(async (promise, modelName) => {
				await promise;

				try {
					await this.connection.indices.create({
						index: `${constants.CHANNEL_KEY_PREFIX}-${applicationId}-${modelName}`
					});

					Services.logger.debug(`Successfully created index: "${constants.CHANNEL_KEY_PREFIX}-${applicationId}-${modelName}"`);
				} catch (err) {
					Services.logger.warning(`Index already exists: "${constants.CHANNEL_KEY_PREFIX}-${applicationId}-${modelName}"`);
				}

				return Promise.resolve();
			}, Promise.resolve());
		}

		if (modifications.deleted.schema) {
			const removedModels = Object.keys(modifications.deleted.schema);
			const indicesToRemove = removedModels.map(modelName => `${constants.CHANNEL_KEY_PREFIX}-${applicationId}-${modelName}`);

			try {
				await this.connection.indices.delete({
					index: indicesToRemove
				});
				Services.logger.debug(`Successfully removed indices: "${indicesToRemove}"`);
			} catch (err) {
				Services.logger.warning(`Error when trying to remove indices: ${err}`);
			}
		}
	}

	/**
     *
     * @param {FilterBuilder} builder
     * @return {Object} The result of <code>builder.build()</code> but with a few translations for ES
     */
	getQueryObject (builder) {
		const translationMappings = {
			is: 'term',
			not: 'not',
			exists: 'exists',
			range: 'range',
			in_array: 'terms',
			like: 'regexp'
		};

		function Translate (node) {
			node.children.forEach(child => {
				if (child instanceof BuilderNode) {
					Translate(child);
				} else {
					let replaced = Object.keys(child)[0];

					if (translationMappings[replaced]) {
						// 'not' contains a filter name
						if (replaced === 'not') {
							let secondReplaced = Object.keys(child[replaced])[0];

							if (translationMappings[secondReplaced] !== secondReplaced) {
								child[replaced][translationMappings[secondReplaced]] = cloneObject(child[replaced][secondReplaced]);
								delete child[replaced][secondReplaced];
							}
						} else if (replaced === 'like') {
							child[translationMappings[replaced]] = cloneObject(child[replaced]);

							let fieldObj = {};

							Object.keys(child[translationMappings[replaced]]).forEach(field => {
								fieldObj[field] = `.*${escapeRegExp(child[translationMappings[replaced]][field])}.*`;
							});
							child[translationMappings[replaced]] = fieldObj;
							delete child[replaced];
						} else if (translationMappings[replaced] !== replaced) {
							child[translationMappings[replaced]] = cloneObject(child[replaced]);
							delete child[replaced];
						}
					}
				}
			});
		}

		Translate(builder.root);

		return builder.build();
	}

	async getObjects (items) {
		if (!Array.isArray(items) || items.length === 0) {
			throw new NexxusError(NexxusError.errors.InvalidFieldValue, 'ElasticSearchDB.getObjects: "ids" should be a non-empty array');
		}

		const docs = items.map(object => {
			let index;

			switch (object.type) {
				case 'application':
				case 'admin': {
					index = `${constants.CHANNEL_KEY_PREFIX}-${object.type}`;

					break;
				}
				default: {
					index = `${constants.CHANNEL_KEY_PREFIX}-${object.application_id}-${object.type}`;
				}
			}

			return {
				_id: object.id,
				_index: index
			};
		}, this);

		const results = await this.connection.mget({
			body: {
				docs
			}
		});
		let errors = [];
		let objects = [];
		let versions = new Map();

		results.docs.forEach(result => {
			if (result.found) {
				objects.push(result._source);
				versions.set(result._id, result._version);
			} else {
				errors.push(new NexxusError(NexxusError.errors.ObjectNotFound, [result._id]));
			}
		});

		return {errors, results: objects, versions};
	}

	async searchObjects (options) {
		let index;
		const reqBody = {
			query: {
				filtered: {
					filter: {}
				}
			}
		};

		switch (options.modelName) {
			case 'application':
			case 'admin': {
				index = `${constants.CHANNEL_KEY_PREFIX}-${options.modelName}`;

				break;
			}
			default: {
				if (Array.isArray(options.modelName)) {
					index = options.modelName.map(model => {
						return `${constants.CHANNEL_KEY_PREFIX}-${options.applicationId}-${model}`;
					}).join(',');
				} else {
					index = `${constants.CHANNEL_KEY_PREFIX}-${options.applicationId}-${options.modelName}`;
				}
			}
		}

		if (options.filters && !options.filters.isEmpty()) {
			reqBody.query = this.getQueryObject(options.filters);
		} else {
			reqBody.query = {match_all: {}};
		}

		if (options.fields) {
			if (!(options.scanFunction instanceof Function)) {
				throw new NexxusError(NexxusError.errors.ServerFailure, ['searchObjects was provided with fields but no scanFunction']);
			}

			let hitsCollected = 0;
			let response = await this.connection.search({
				index,
				body: reqBody,
				scroll: '10s',
				fields: options.fields,
				size: 1024
			});

			do {
				let objects = [];

				hitsCollected += response.hits.hits.length;

				response.hits.hits.forEach(hit => {
					let obj = {};

					for (const f in hit.fields) {
						obj[f] = hit.fields[f][0];
					}

					objects.push(obj);
				});

				if (response.hits.hits.length) {
					await options.scanFunction(objects);
				}

				response = await this.connection.scroll({
					scrollId: response._scroll_id,
					scroll: '10s'
				});
			} while (response.hits.total !== hitsCollected);

			return null;
		}

		if (options.sort) {
			reqBody.sort = [];

			Object.keys(options.sort).forEach(field => {
				let sortObjectField = {};

				if (!options.sort[field].type) {
					sortObjectField[field] = { order: options.sort[field].order, unmapped_type: 'long' };
				} else if (options.sort[field].type === 'geo') {
					sortObjectField._geo_distance = {};
					sortObjectField._geo_distance[field] = { lat: options.sort[field].poi.lat || 0.0, lon: options.sort[field].poi.long || 0.0 };
					sortObjectField._geo_distance.order = options.sort[field].order;
				}

				reqBody.sort.push(sortObjectField);
			});
		}

		const results = await this.connection.search({
			index,
			body: reqBody,
			from: options.offset,
			size: options.limit
		});

		return {results: results.hits.hits.map(object => object._source)};
	}

	async countObjects (modelName, options) {
		let index;
		let reqBody = {
			query: {
				filtered: {
					filter: {}
				}
			}
		};

		switch (modelName) {
			case 'application':
			case 'admin': {
				index = `${constants.CHANNEL_KEY_PREFIX}-${modelName}`;

				break;
			}

			default: {
				index = `${constants.CHANNEL_KEY_PREFIX}-${options.applicationId}-${modelName}`;
			}
		}

		if (options.filters && !options.filters.isEmpty()) {
			reqBody.query.filtered.filter = this.getQueryObject(options.filters);
		}

		if (options.aggregation) {
			reqBody.aggs = { aggregation: options.aggregation };

			const result = await this.connection.search({
				index,
				body: reqBody,
				search_type: 'count',
				queryCache: true
			});

			let countResult = { count: result.hits.total };

			countResult.aggregation = result.aggregations.aggregation.value;

			return Object.assign({ count: result.hits.total }, { aggregation: result.aggregations.aggregation.value });
		}

		const result = await this.connection.count({
			index,
			body: reqBody
		});

		return { count: result.count };
	}

	async createObjects (objects) {
		if (!Array.isArray(objects) || objects.length === 0) {
			throw new NexxusError('InvalidFieldValue', ['ElasticSearchDB.createObjects: "objects" should be a non-empty array']);
		}

		let shouldRefresh = false;
		let bulk = [];
		let errors = [];

		await objects.reduce(async (promise, obj) => {
			await promise;

			let index;

			switch (obj.type) {
				case 'admin':
				case 'application': {
					index = `${constants.CHANNEL_KEY_PREFIX}-${obj.type}`;

					shouldRefresh = true;

					if (obj.schema) {
						await Object.keys(obj.schema).reduce(async (p, modelName) => {
							await p;

							return this.connection.indices.create({
								index: `${constants.CHANNEL_KEY_PREFIX}-${obj.id}-${modelName}`
							});
						}, Promise.resolve());
					}

					break;
				}
				default: {
					index = `${constants.CHANNEL_KEY_PREFIX}-${obj.applicationId}-${obj.type}`;
				}
			}

			bulk.push({ index: { _id: obj.id, _index: index, _type: '_doc' } });
			bulk.push(obj);

			return Promise.resolve();
		}, Promise.resolve());

		if (bulk.length !== objects.length * 2) {
			Services.logger.warning(`ElasticSearchDB.createObjects: some objects were missing their "type" and "id" (${(objects.length - bulk.length / 2)} failed)`);
		}

		if (!bulk.length) {
			return null;
		}

		const res = await this.connection.bulk({
			body: bulk,
			refresh: shouldRefresh
		});

		if (res.errors) {
			res.items.forEach(error => {
				errors.push(new NexxusError('ServerFailure', `Error creating ${error.index._type}: ${error.index.error}`));
			});
		}

		return {errors};
	}

	async updateObjects (patches) {
		if (!Array.isArray(patches) || patches.length === 0) {
			throw new NexxusError(NexxusError.errors.InvalidFieldValue, 'ElasticSearchDB.updateObjects: "patches" should be a non-empty array');
		}

		let errors = [];
		let shouldRefresh = false;
		let finalResults = new Map();

		async function getAndUpdate (objectPatches) {
			let conflictedObjectPatches = [];
			let objectsToGet = new Map();
			let modifiedApplicationSchemas = new Map();

			objectPatches.forEach(patch => {
				if (!(patch instanceof NexxusPatch)) {
					throw new TypeError('ElasticSearchDB.updateObjects: array elements must all be instances of NexxusPatch');
				}

				if (objectsToGet.has(patch.id)) {
					objectsToGet.get(patch.id).patches.push(patch);
				} else {
					objectsToGet.set(patch.id, { id: patch.id, type: patch.model, application_id: patch.applicationId, patches: [patch] });
				}
				// we need to remember which application had its schema modified
				if (patch.field === 'schema') {
					modifiedApplicationSchemas.set(patch.id, true);
				}
			});
			let bulk = [];

			if (objectPatches.length === 0) {
				return null;
			}

			let { errors: notFoundErrors, results, versions } = await this.getObjects(Array.from(objectsToGet.values()));

			errors = errors.concat(notFoundErrors);

			if (!results || !results.length) {
				return null;
			}

			results = results.map(dbObject => {
				return utils.getProperModel(dbObject);
			});
			results.forEach(model => {
				const {diff, detailedDiff} = NexxusPatch.applyPatches(objectsToGet.get(model.properties.id).patches, model);
				let index;

				if (modifiedApplicationSchemas.has(model.properties.id)) {
					try {
						// we don't want this to delay other writes
						this[processSchemaModificationMethod](model.properties.id, detailedDiff);
					} catch (err) {
						Services.logger.warning(`Unable to process schema modifications: ${err}`);
					}
				}

				finalResults.set(model.properties.id, model);

				switch (model.properties.type) {
					case 'application':
					case 'admin': {
						index = `${constants.CHANNEL_KEY_PREFIX}-${model.properties.type}`;
						shouldRefresh = true;

						break;
					}
					default: {
						index = `${constants.CHANNEL_KEY_PREFIX}-${model.properties.application_id}-${model.properties.type}`;
					}
				}

				bulk.push({ update: { _id: model.properties.id, _version: versions[model.properties.id], _index: index, _type: '_doc' } });
				bulk.push({ doc: diff });
			});

			const res = await this.connection.bulk({
				body: bulk,
				refresh: shouldRefresh
			});

			if (res.errors) {
				res.items.forEach(error => {
					if (error.update.status === 409) {
						objectsToGet.get(error.update._id).patches.forEach(patch => {
							conflictedObjectPatches.push(patch);
						});
					} else {
						errors.push(new Error(`Failed to update ${objectsToGet.get(error.update._id).type} with ID ${error.update._id}: ${error.update.error.reason}`));
					}
				});
			}

			if (conflictedObjectPatches.length) {
				Services.logger.debug(`Retry-on-conflict object count: ${conflictedObjectPatches.length}`);

				return getAndUpdate.call(this, conflictedObjectPatches);
			}

			return null;
		}

		await getAndUpdate.call(this, patches);

		return {errors, results: Array.from(finalResults.values())};
	}

	async deleteObjects (objects) {
		if (!(objects instanceof Map)) {
			throw new NexxusError(NexxusError.errors.InvalidFieldValue, 'deleteObjects must be supplied a Map');
		}

		let errors = [];
		let deleted = [];
		let bulk = [];
		let shouldRefresh = false;

		objects.forEach((object, id) => {
			if (typeof id !== 'string') {
				errors.push(new NexxusError(NexxusError.errors.InvalidFieldValue,
					`object with ID "${id}" supplied for deleteObjects is not a valid model type`));

				return null;
			}

			let index;

			switch (object.type) {
				case 'application':
				case 'admin': {
					index = `${constants.CHANNEL_KEY_PREFIX}-${object.type}`;
					shouldRefresh = true;

					break;
				}
				default: {
					index = `${constants.CHANNEL_KEY_PREFIX}-${object.application_id}-${id}`;
				}
			}

			return bulk.push({ delete: { _index: index, _id: id, _type: '_doc' } });
		});

		if (bulk.length === 0) {
			return {errors};
		}

		const results = await this.connection.bulk({
			body: bulk,
			refresh: shouldRefresh
		});

		results.items.forEach(result => {
			if (result.delete.result === 'not_found') {
				errors.push(new NexxusError(NexxusError.errors.ObjectNotFound, [result.delete._id]));
			} else {
				deleted.push(result.delete._id);
			}
		});

		return {errors, results: deleted};
	}
}

function escapeRegExp (str) {
	return str.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&');
}

module.exports = ElasticSearchDB;
