const MainDatabaseAdapter = require('./mainDatabase.js');
const elasticsearch = require('elasticsearch');
const async = require('async');
const Delta = require('../Delta');
const TelepatError = require('../TelepatError');
const AgentKeepAlive = require('agentkeepalive');
const cloneObject = require('clone');
const BuilderNode = require('../../utils/filterbuilder').BuilderNode;
const Model = require('../Model');
const Application = require('../Application');

let builtinModels = {
	user: require('../User'),
	application: require('../Application'),
	context: require('../Context'),
	admin: require('../Admin')
};

let Services;

class ElasticSearchDB extends MainDatabaseAdapter {
	constructor (config) {
		if (typeof config !== 'object' || Object.keys(config).length === 0) {
			throw new TelepatError(TelepatError.errors.ServerFailure, ['supplied empty or invalid configuration parameter']);
		}

		let esConfig = {
			apiVersion: '1.7',
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
		super(new elasticsearch.Client(esConfig));

		this.config = config;

		this.config.subscribe_limit = this.config.subscribe_limit || 64;
		this.config.get_limit = this.config.get_limit || 384;

		let retryConnection = () => {
			// we had to copy paste the config letiable because the es sdk doesn't allow to reuse the config object
			esConfig = {
				apiVersion: '1.7',
				keepAlive: true,
				maxSockets: 300,
				createNodeAgent (connection, config) {
					return new AgentKeepAlive(connection.makeAgentConfig(config));
				}
			};

			if (this.config.hosts) {
				esConfig.hosts = this.config.hosts;
			} else if (this.config.host) {
				esConfig.host = this.config.host;
				esConfig.sniffOnStart = true;
				esConfig.sniffInterval = 30000;
				esConfig.sniffOnConnectionFault = true;
			}

			this.connection = new elasticsearch.Client(esConfig);
		};

		this.connection.ping({
			requestTimeout: Infinity
		}, err => {
			if (err) {
				Services.logger.error(`Failed connecting to Elasticsearch "${this.config.host}": ${err.message}. Retrying...`);
				setTimeout(retryConnection, 1000);
			} else {
				Services.logger.info('Connected to ElasticSearch MainDatabase');
				this.emit('ready');
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

	getObjects (ids, callback) {
		if (!Array.isArray(ids) || ids.length === 0) {
			return callback([new TelepatError(TelepatError.errors.InvalidFieldValue, ['ElasticSearchDB.getObjects: "ids" should be a non-empty array'])], [], []);
		}

		ids = ids.map(id => ({
			_id: id
		}), this);

		return this.connection.mget({
			index: this.config.index,
			body: {
				docs: ids
			}
		}, (err, results) => {
			if (err) {
				return callback([err]);
			}

			let notFoundErrors = [];
			let objects = [];
			let versions = {};

			return async.each(results.docs, (result, c) => {
				if (result.found) {
					objects.push(result._source);
					versions[result._id] = result._version;
				} else {
					notFoundErrors.push(new TelepatError(TelepatError.errors.ObjectNotFound, [result._id]));
				}

				c();
			}, () => callback(notFoundErrors, objects, versions));
		});
	}

	searchObjects (options, callback) {
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
				return callback(new TelepatError(TelepatError.errors.ServerFailure, ['searchObjects was provided with fields but no scanFunction']));
			}

			let hitsCollected = 0;

			return this.connection.search({
				index: this.config.index,
				type: options.modelName ? options.modelName : '',
				body: reqBody,
				scroll: '10s',
				searchType: 'scan',
				fields: options.fields,
				size: 1024
			}, function getMore (err, response) {
				if (err) {
					return callback(err);
				}

				if (response.hits.total !== hitsCollected) {
					let objects = [];

					hitsCollected += response.hits.hits.length;

					return async.each(response.hits.hits, (hit, c) => {
						let obj = {};

						async.forEachOf(hit.fields, (value, f, c1) => {
							obj[f] = value[0];
							c1();
						}, () => {
							objects.push(obj);
							c();
						});
					}, () => {
						if (response.hits.hits.length) {
							options.scanFunction(objects);
						}

						this.connection.scroll({
							scrollId: response._scroll_id,
							scroll: '10s'
						}, getMore);
					});
				}

				return callback();
			});
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

		return this.connection.search({
			index: this.config.index,
			type: options.modelName,
			body: reqBody,
			from: options.offset,
			size: options.limit
		}, (err, results) => {
			if (err) {
				return callback(err);
			}

			let objects = [];

			results.hits.hits.forEach(object => {
				objects.push(object._source);
			});

			return callback(null, objects);
		});
	}

	countObjects (options, callback) {
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

			this.connection.search({
				index: this.config.index,
				type: options.modelName,
				body: reqBody,
				search_type: 'count',
				queryCache: true
			}, (err, result) => {
				if (err) {
					return callback(err);
				}

				let countResult = { count: result.hits.total };

				countResult.aggregation = result.aggregations.aggregation.value;

				return callback(null, Object.assign({ count: result.hits.total }, { aggregation: result.aggregations.aggregation.value }));
			});
		} else {
			this.connection.count({
				index: this.config.index,
				type: options.modelName,
				body: reqBody
			}, (err, result) => {
				if (err) {
					return callback(err);
				}

				return callback(null, { count: result.count });
			});
		}
	}

	createObjects (objects, callback) {
		if (!Array.isArray(objects) || objects.length === 0) {
			return callback([new TelepatError(TelepatError.errors.InvalidFieldValue, ['ElasticSearchDB.createObjects: "objects" should be a non-empty array'])], [], []);
		}

		let bulk = [];
		let builtinDetected = false;

		objects.forEach(obj => {
			let modelName;

			if (obj.type && obj.id) {
				modelName = obj.type;

				if (builtinModels.indexOf(modelName) !== -1) {
					builtinDetected = true;
				}

				bulk.push({ index: { _type: modelName, _id: obj.id } });
				bulk.push(obj);
			}
		});

		if (bulk.length !== objects.length * 2) {
			Application.logger.warning(`
ElasticSearchDB.createObjects: some objects were missing their "type" and "id" (${(objects.length - bulk.length / 2)} failed)`);
		}

		if (!bulk.length) {
			return callback();
		}

		return this.connection.bulk({
			index: this.config.index,
			body: bulk,
			refresh: builtinDetected
		}, (err, res) => {
			if (res.errors) {
				res.items.forEach(error => {
					Services.logger.error(`Error creating ${error.index._type}: ${error.index.error}`);
				});
			}

			callback(err, res);
		});
	}

	updateObjects (patches, callback) {
		if (!Array.isArray(patches) || patches.length === 0) {
			return callback([new TelepatError(TelepatError.errors.InvalidFieldValue, ['ElasticSearchDB.updateObjects: "patches" should be a non-empty array'])], {});
		}

		let ids = {};
		let dbObjects = {};
		let totalErrors = [];
		let builtinDetected = false;

		patches.forEach(patch => {
			if (!patch.path || typeof patch.path !== 'string') {
				return totalErrors.push(new TelepatError(TelepatError.errors.InvalidPatch, ['path is missing or invalid']));
			} else if (patch.path.split('/').length !== 3) {
				return totalErrors.push(new TelepatError(TelepatError.errors.InvalidPatch, ['the path is malformed']));
			}

			let id = patch.path.split('/')[1];

			if (!ids[id]) {
				ids[id] = [patch];
			} else {
				ids[id].push(patch);
			}

			return null;
		});

		function getAndUpdate (objectPatches, callback2) {
			let dbObjectVersions = {};
			let conflictedObjectIds = {};
			let localIds = Object.keys(objectPatches);
			let bulk = [];

			if (localIds.length === 0) {
				return callback2();
			}

			async.series([
				function getObjects (callback1) {
					this.getObjects(localIds, (err, results, versions) => {
						totalErrors = totalErrors.concat(err);

						if (!results || !results.length) {
							return callback1();
						}

						results.forEach(obj => {
							let object;

							if (obj.properties) {
								object = obj.properties;
							} else {
								object = obj;
							}

							let type = object.type;

							if (builtinModels[type]) {
								dbObjects[object.id] = new builtinModels[type](object);
							} else if (type !== 'user_metadata') {
								dbObjects[object.id] = new Model(object);
							} else {
								dbObjects[object.id] = object;
							}
							dbObjectVersions[object.id] = versions[object.id];
						});

						return callback1();
					});
				},
				function updateBulk (callback1) {
					if (!Object.keys(dbObjects).length) {
						return callback1();
					}

					return async.forEachOf(objectPatches, (patches, id, c) => {
						// no object with that ID has been found in the db
						if (!dbObjects[id]) {
							return c();
						}
						let objectModel = null;

						objectModel = patches[0].path.split('/')[0];

						if (builtinModels[objectModel]) {
							builtinDetected = true;
						}

						if (dbObjects[id].properties) {
							dbObjects[id] = dbObjects[id].properties;
						}

						let result = Delta.processObject(patches, dbObjects[id]);

						dbObjects[id] = result.final;

						bulk.push({ update: { _type: objectModel, _id: id, _version: dbObjectVersions[id] } });
						bulk.push({ doc: result.diff });

						return c();
					}, () => {
						if (!bulk.length) {
							return callback1();
						}

						return this.connection.bulk({
							index: this.config.index,
							body: bulk,
							refresh: builtinDetected
						}, (err, res) => {
							if (err) {
								return callback1(err);
							}

							if (res.errors) {
								res.items.forEach(error => {
									if (error.update.status === 409) {
										conflictedObjectIds[error.update._id] = ids[error.update._id];
									}
									else {
										totalErrors.push(new Error(`Failed to update ${error.update._type} with ID ${error.update._id}: ${error.update.error}`));
									}
								});
							}

							return callback1();
						});
					});
				}
			], err => {
				if (err) {
					return callback2(err, {});
				}

				if (Object.keys(conflictedObjectIds).length) {
					return getAndUpdate(conflictedObjectIds, callback2);
				}

				return callback2();
			});
		}

		return getAndUpdate(ids, err => {
			if (err) {
				callback(err, {});
			} else {
				// quick trick to avoid using Object.keys on objects with lots of elements
				for (let prop in dbObjects) {
					if (prop) {
						return callback(totalErrors, dbObjects);
					}
				}

				callback(totalErrors, {});
			}
		});
	}

	deleteObjects (ids, callback) {
		if (typeof ids !== 'object') {
			return callback([new TelepatError(TelepatError.errors.InvalidFieldValue, ['deleteObjects must be supplied an object'])]);
		} else if (Object.keys(ids).length === 0) {
			return callback([]);
		}

		let errors = [];
		let bulk = [];
		let builtinDetected = false;

		return async.each(Object.keys(ids), (id, c) => {
			if (typeof ids[id] !== 'string') {
				errors.push(new TelepatError(TelepatError.errors.InvalidFieldValue,
					[`object with ID "${id}" supplied for deleteObjects is not a valid model type`]));

				return setImmediate(c);
			}

			if (builtinModels.indexOf(ids[id]) !== -1) {
				builtinDetected = true;
			}

			bulk.push({ delete: { _type: ids[id], _id: id } });
			c();
		}, () => {
			if (bulk.length === 0) {
				return setImmediate(function () {
					callback(errors);
				});
			}

			return this.connection.bulk({
				index: this.config.index,
				body: bulk,
				refresh: builtinDetected
			}, (err, results) => {
				if (err) {
					return callback([err]);
				}

				return async.each(results.items, (result, c) => {
					if (!result.delete.found) {
						errors.push(new TelepatError(TelepatError.errors.ObjectNotFound, [result.delete._id]));
					}

					c();
				}, () => {
					callback(errors);
				});
			});
		});
	}
}

function escapeRegExp (str) {
	return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');
}

module.exports = services => {
	Services = services;

	return ElasticSearchDB;
};
