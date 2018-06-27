const MainDatabaseAdapter = require('../mainDatabase.js');
const elasticsearch = require('elasticsearch');
const AgentKeepAlive = require('agentkeepalive');
const cloneObject = require('clone');
const async = require('async');
const {BuilderNode} = require('../../../utils/filterbuilder');
const Delta = require('../../Delta');
const NexxusError = require('../../NexxusError');
const Model = require('../../Model');
const Services = require('../../Services');

const tryConnection = Symbol('try connection private method');

class ElasticSearchDB extends MainDatabaseAdapter {
	constructor (config) {
		if (typeof config !== 'object' || Object.keys(config).length === 0) {
			throw new NexxusError(NexxusError.errors.ServerFailure, ['supplied empty or invalid configuration parameter']);
		}

		let esConfig = {
			maxRetries: 10,
			deadTimeout: 1e4,
			pingTimeout: 3000,
			apiVersion: '6.2',
			keepAlive: true,
			maxSockets: 300,
			log: false,
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
		super(new elasticsearch.Client(esConfig));

		this.connection = new Proxy(this.connection, {
			apply: (target, ctx, args) => {
				try {
					return Reflect.apply(target, ctx, args);
				} catch (e) {
					if (e.message === 'No Living connections' && !this.reconnecting) {
						this.reconnecting = true;
						Services.logger.emergency(`Lost connection to elasticsearch: ${e.message}`);

						setTimeout(5000, () => {
							this[tryConnection]();
						});

						return this.emit('disconnect');
					}

					throw e;
				}
			}
		});

		this.config = config;
		this.config.subscribe_limit = this.config.subscribe_limit || 64;
		this.config.get_limit = this.config.get_limit || 384;
		this.connected = false;
		this.reconnecting = false;

		this[tryConnection]();
	}

	[tryConnection] () {
		let error = false;

		async.doWhilst(callback => {
			this.connection.ping({}, err => {
				if (!err) {
					Services.logger.info('Connected to ElasticSearch MainDatabase');
					this.connected = true;

					return setImmediate(callback);
				}

				if (err.message === 'No Living connections') {
					Services.logger.error(`Failed connecting to Elasticsearch "${this.config.host || this.config.hosts.join(', ')}": ${err.message}. Retrying...`);
					setTimeout(callback, 5000);
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

	async getObjects (ids) {
		if (!Array.isArray(ids) || ids.length === 0) {
			throw new NexxusError(NexxusError.errors.InvalidFieldValue, 'ElasticSearchDB.getObjects: "ids" should be a non-empty array');
		}

		ids = ids.map(id => ({
			_id: id
		}), this);

		const results = await this.connection.mget({
			index: this.config.index,
			body: {
				docs: ids
			}
		});
		let errors = [];
		let objects = [];
		let versions = {};

		results.docs.forEach(result => {
			if (result.found) {
				objects.push(result._source);
				versions[result._id] = result._version;
			} else {
				errors.push(new NexxusError(NexxusError.errors.ObjectNotFound, [result._id]));
			}
		});

		return {errors, results: objects, versions};
	}

	async searchObjects (options) {
		const reqBody = {
			query: {
				filtered: {
					filter: {}
				}
			}
		};

		if (options.filters && !options.filters.isEmpty()) {
			reqBody.query.filtered.filter = this.getQueryObject(options.filters);
		}

		if (options.fields) {
			if (!(options.scanFunction instanceof Function)) {
				throw new NexxusError(NexxusError.errors.ServerFailure, ['searchObjects was provided with fields but no scanFunction']);
			}

			let hitsCollected = 0;
			let response = await this.connection.search({
				index: this.config.index,
				type: options.modelName ? options.modelName : '',
				body: reqBody,
				scroll: '10s',
				searchType: 'scan',
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
					options.scanFunction(objects);
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

			let sortFieldName = Object.keys(options.sort)[0];

			// old sort method
			if (typeof options.sort[sortFieldName] === 'string') {
				let sortObject = {};

				sortObject[sortFieldName] = { order: options.sort[sortFieldName], unmapped_type: 'long' };
				reqBody.sort = [sortObject];
			} else {
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
		}

		const results = await this.connection.search({
			index: this.config.index,
			type: options.modelName,
			body: reqBody,
			from: options.offset,
			size: options.limit
		});

		return {results: results.hits.hits.map(object => object._source)};
	}

	async countObjects (options) {
		let reqBody = {
			query: {
				filtered: {
					filter: {}
				}
			}
		};

		if (options.filters && !options.filters.isEmpty()) {
			reqBody.query.filtered.filter = this.getQueryObject(options.filters);
		}

		if (options.aggregation) {
			reqBody.aggs = { aggregation: options.aggregation };

			const result = await this.connection.search({
				index: this.config.index,
				type: options.modelName,
				body: reqBody,
				search_type: 'count',
				queryCache: true
			});

			let countResult = { count: result.hits.total };

			countResult.aggregation = result.aggregations.aggregation.value;

			return Object.assign({ count: result.hits.total }, { aggregation: result.aggregations.aggregation.value });
		}

		const result = await this.connection.count({
			index: this.config.index,
			type: options.modelName,
			body: reqBody
		});

		return { count: result.count };
	}

	async createObjects (objects) {
		if (!Array.isArray(objects) || objects.length === 0) {
			throw new NexxusError('InvalidFieldValue', ['ElasticSearchDB.createObjects: "objects" should be a non-empty array']);
		}

		let bulk = [];
		let errors = [];
		let builtinDetected = false;

		objects.forEach(obj => {
			let modelName;

			if (obj.type && obj.id) {
				modelName = obj.type;

				/* if (builtinModels.indexOf(modelName) !== -1) {
					builtinDetected = true;
				} */

				bulk.push({ index: { _type: modelName, _id: obj.id } });
				bulk.push(obj);
			} else {
				errors.push(new NexxusError('MissingRequiredField', ['"id" or "type"']));
			}
		});

		if (bulk.length !== objects.length * 2) {
			Services.logger.warning(`ElasticSearchDB.createObjects: some objects were missing their "type" and "id" (${(objects.length - bulk.length / 2)} failed)`);
		}

		if (!bulk.length) {
			return null;
		}

		const res = await this.connection.bulk({
			index: this.config.index,
			body: bulk,
			refresh: builtinDetected
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

		let ids = {};
		let dbObjects = {};
		let errors = [];
		let builtinDetected = false;

		patches.forEach(patch => {
			if (!patch.path || typeof patch.path !== 'string') {
				return errors.push(new NexxusError(NexxusError.errors.InvalidPatch, ['path is missing or invalid']));
			} else if (patch.path.split('/').length !== 3) {
				return errors.push(new NexxusError(NexxusError.errors.InvalidPatch, ['the path is malformed']));
			}

			let id = patch.path.split('/')[1];

			if (!ids[id]) {
				ids[id] = [patch];
			} else {
				ids[id].push(patch);
			}

			return null;
		});

		async function getAndUpdate (objectPatches) {
			let dbObjectVersions = {};
			let conflictedObjectIds = {};
			let localIds = Object.keys(objectPatches);
			let bulk = [];

			if (localIds.length === 0) {
				return null;
			}

			const { notFoundErrors, results, versions } = await this.getObjects(localIds);

			errors = errors.concat(notFoundErrors);

			if (!results || !results.length) {
				return null;
			}

			results.forEach(obj => {
				let object;

				if (obj.properties) {
					object = obj.properties;
				} else {
					object = obj;
				}

				let type = object.type;

				/* if (builtinModels[type]) {
					dbObjects[object.id] = new builtinModels[type](object);
				} else  */if (type !== 'user_metadata') {
					dbObjects[object.id] = new Model(object);
				} else {
					dbObjects[object.id] = object;
				}

				dbObjectVersions[object.id] = versions[object.id];
			});

			if (!Object.keys(dbObjects).length) {
				return null;
			}

			for (const id in objectPatches) {
				// no object with that ID has been found in the db
				if (!dbObjects[id]) {
					continue;
				}
				let objectModel = null;

				objectModel = objectPatches[id][0].path.split('/')[0];

				/* if (builtinModels[objectModel]) {
					builtinDetected = true;
				} */

				if (dbObjects[id].properties) {
					dbObjects[id] = dbObjects[id].properties;
				}

				let result = Delta.processObject(objectPatches[id], dbObjects[id]);

				dbObjects[id] = result.final;

				bulk.push({ update: { _type: objectModel, _id: id, _version: dbObjectVersions[id] } });
				bulk.push({ doc: result.diff });
			}

			const res = await this.connection.bulk({
				index: this.config.index,
				body: bulk,
				refresh: builtinDetected
			});

			if (res.errors) {
				res.items.forEach(error => {
					if (error.update.status === 409) {
						conflictedObjectIds[error.update._id] = ids[error.update._id];
					} else {
						errors.push(new Error(`Failed to update ${error.update._type} with ID ${error.update._id}: ${error.update.error}`));
					}
				});
			}

			if (Object.keys(conflictedObjectIds).length) {
				return getAndUpdate(conflictedObjectIds);
			}

			return null;
		}

		await getAndUpdate(ids);

		return {errors, results: dbObjects};
	}

	async deleteObjects (ids) {
		if (typeof ids !== 'object') {
			throw new NexxusError(NexxusError.errors.InvalidFieldValue, 'deleteObjects must be supplied an object');
		} else if (Object.keys(ids).length === 0) {
			return {};
		}

		let errors = [];
		let deleted = [];
		let bulk = [];
		let builtinDetected = false;

		for (const id in ids) {
			if (typeof ids[id] !== 'string') {
				errors.push(new NexxusError(NexxusError.errors.InvalidFieldValue,
					`object with ID "${id}" supplied for deleteObjects is not a valid model type`));

				continue;
			}

			/* if (builtinModels.indexOf(ids[id]) !== -1) {
				builtinDetected = true;
			} */

			bulk.push({ delete: { _type: ids[id], _id: id } });
		}

		if (bulk.length === 0) {
			return {errors};
		}

		const results = await this.connection.bulk({
			index: this.config.index,
			body: bulk,
			refresh: builtinDetected
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
