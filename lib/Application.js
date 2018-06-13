const BaseModel = require('./BaseModel');
const guid = require('uuid');
const Services = require('./Services');
const async = require('async');
const FilterBuilder = require('../utils/filterbuilder').FilterBuilder;
const TelepatError = require('./TelepatError');
const Context = require('./Context');
const Users = require('./User');
const constants = require('./constants');

class TelepatApplication extends BaseModel {
	/**
	 *
	 * @param {TelepatApplication} props
	 */
	constructor (props) {
		props.admins = Array.isArray(props.admins) ? props.admins : [];
		props.keys = Array.isArray(props.keys) ? props.keys : [];
		props.type = 'application';

		const proxiedParent = super(props, ['admins', 'keys']);

		proxiedParent.contexts = {
			new: Context.new(props.id),
			get: Context.get(props.id),
			update: Context.update(props.id),
			delete: Context.delete(props.id)
		};
		proxiedParent.users = {
			new: (prop, callback) => {
				prop.application_id = this.id;
				Users.new(prop, callback);
			},
			get: (user, callback) => {
				Users.get(user, this.id, callback);
			},
			update: Users.update,
			delete: Users.delete
		};

		return proxiedParent;
	}

	static async new (props, callback) {
		props.id = guid.v4();
		let app = new TelepatApplication(props);

		await Services.datasource.dataStorage.createObjects([app.properties]);
		TelepatApplication.apps[props.id] = app;

		return TelepatApplication.apps[props.id];
	}

	static get (id) {
		return TelepatApplication.apps[id];
	}

	delete (callback) {
		let id = this.id;

		async.series([
			callback1 => {
				let appObj = {};

				appObj[this.id] = 'application';
				Services.datasource.dataStorage.deleteObjects(appObj, callback1);
			},
			callback1 => {
				delete TelepatApplication.apps[id];

				let deleteAppObjects = obj => {
					let deleteObjects = {};

					async.each(obj, (o, c) => {
						deleteObjects[o.id] = o.type;
						c();
					}, () => {
						Services.datasource.dataStorage.deleteObjects(deleteObjects, errs => {
							if (errs && errs.length > 1) {
								Services.logger.warning(`Failed to delete ${errs.length} application objects.`);
							}
						});
					});
				};
				let filter = (new FilterBuilder()).addFilter('is', { application_id: id });

				Services.datasource.dataStorage.searchObjects({ filters: filter, fields: ['id', 'type'], scanFunction: deleteAppObjects }, callback1);
			},
			callback1 => {
				Services.redisClient.del(`blg:application:${id}`, callback1);
			}
		], callback);
	}

	update (patches, callback) {
		let id = this.id;

		async.waterfall([
			callback1 => {
				Services.datasource.dataStorage.updateObjects(patches, (errs, apps) => {
					if (errs && errs.length) {
						return callback1(errs[0]);
					}

					let application = apps[id];

					if (!(apps[id] instanceof TelepatApplication)) {
						application = new TelepatApplication(apps[id]);
					}

					TelepatApplication.apps[id] = application;

					return callback1(null, application);
				});
			},
			(application, callback1) => {
				Services.redisClient.del(`blg:application:${id}`, err => {
					if (err) {
						return callback1(err);
					}

					return callback1(null, application);
				});
			}
		], callback);
	}

	static async getAll () {
		let offset = 0;
		let limit = Services.datasource.dataStorage.config.get_limit;

		(await Services.datasource.dataStorage.searchObjects({ modelName: 'application', offset, limit })).forEach(app => {
			TelepatApplication.apps[app.id] = new TelepatApplication(app);
		});

		return TelepatApplication.apps;
	}

	hasContext (contextId, callback) {
		let appId = this.id;

		Context.get(contextId, (err, res) => {
			if (err) {
				return callback(err);
			}

			return callback(null, res.application_id === appId);
		});
	}

	static isAdmin (admin) {
		for (let r in TelepatApplication.apps) {
			if (TelepatApplication.apps[r].admins.indexOf(admin.id) !== -1) {
				return true;
			}
		}

		return false;
	}

	isAPNConfigured () {
		return (this.apn_key && this.apn_key_id && this.apn_team_id && this.apn_topic);
	}

	isGCMCofigured () {
		return !!(this.gcm_api_key);
	}

	static isBuiltInModel (modelName) {
		if (constants.builtinModels.indexOf(modelName) !== -1) {
			return true;
		}

		return false;
	}

	modelSchema (modelName) {
		let schemaObj = this.properties.schema;
		let obj = {};

		obj.belongsTo = parentName => {
			if (schemaObj[modelName].belongsTo) {
				return !!schemaObj[modelName].belongsTo.find(parent => parent.parentModel === parentName);
			}

			return false;
		};

		obj.hasParent = modelParent => {
			let applicationId = this.id;
			let appModels = TelepatApplication.apps[applicationId].schema;

			if (!appModels[modelName].belongsTo) {
				return false;
			}

			if (!appModels[modelParent]) {
				return false;
			}

			let relationType = appModels[modelName].belongsTo.relationType;

			if (appModels[modelParent].belongsTo.parentModel !== modelName) {
				return false;
			}

			if (relationType) {
				if (appModels[modelParent][relationType].indexOf(modelName) === -1) {
					return false;
				}
			}

			return true;
		};

		obj.hasSome = modelParent => {
			if ((schemaObj[modelName].hasSome.indexOf(modelParent) !== -1)) {
				return schemaObj[modelName].hasSome_property;
			}

			return false;
		};

		obj.hasMany = modelParent => {
			return (schemaObj[modelName].hasMany.indexOf(modelParent) !== -1);
		};

		obj.isValidModel = () => {
			let app = TelepatApplication.apps[this.properties.id];

			if (TelepatApplication.isBuiltInModel(modelName)) {
				return new TelepatError(TelepatError.errors.InvalidFieldValue, modelName);
			}

			if (!app.schema) {
				return new TelepatError(TelepatError.errors.ApplicationHasNoSchema);
			}

			if (!app.schema[modelName]) {
				return new TelepatError(TelepatError.errors.ApplicationSchemaModelNotFound, this.properties.id, modelName);
			}

			return true;
		};

		return obj;
	}

	updateSchema (schema, callback) {
		let appId = this.id;

		async.series([
			callback1 => {
				Services.datasource.dataStorage.updateObjects([
					{
						op: 'replace',
						path: `application/${appId}/schema`,
						value: schema
					}
				], errs => {
					callback1(errs && errs.length ? errs[0] : null);
				});
			},
			callback1 => {
				Services.redisClient.del(`blg:application:${appId}`, (err, result) => {
					if (err) {
						return callback1(err);
					}

					return callback1(null, schema);
				});
			}
		], callback);
	}

	deleteModel (modelName, callback) {
		let appId = this.id;
		let validation = TelepatApplication.apps[appId].modelSchema(modelName).isValidModel();

		if (validation instanceof TelepatError) {
			return validation;
		}

		return async.series([
			callback1 => {
				delete TelepatApplication.apps[appId].schema[modelName];
				Services.datasource.dataStorage.updateObjects([
					{
						op: 'replace',
						path: `application/${appId}/schema`,
						value: TelepatApplication.apps[appId].schema
					}
				], (errs, results) => {
					if (errs && errs.length) {
						return callback1(errs[0]);
					}

					return callback1();
				});
			},
			callback1 => {
				Services.redisClient.del(`blg:application:${appId}`, callback1);
			}
		], callback);
	}
}

/**
 *  @property {TelepatApplication[]} apps All the apps
 */
TelepatApplication.apps = [];
TelepatApplication.models = require('./Model');
TelepatApplication.contexts = require('./Context');
TelepatApplication.users = require('./User');

module.exports = TelepatApplication;
