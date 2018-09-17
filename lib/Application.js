const BaseModel = require('./BaseModel');
const guid = require('uuid');
const Services = require('./Services');
const FilterBuilder = require('../utils/filterbuilder').FilterBuilder;
const NexxusError = require('./NexxusError');
const Context = require('./Context');
const Users = require('./User');
const ApplicationSchema = require('./ApplicationSchema');
const promisify = require('util').promisify;

const apps = new Map();

class NexxusApplication extends BaseModel {
	constructor (props) {
		props.admins = Array.isArray(props.admins) ? props.admins : [];
		props.keys = Array.isArray(props.keys) ? props.keys : [];
		props.type = 'application';
		if (props.schema) {
			if (!(props.schema instanceof ApplicationSchema)) {
				props.schema = new ApplicationSchema(props.schema);
			}
		}

		super(props, ['admins', 'keys']);

		this.contexts = {
			create: Context.create(this.properties.id),
			get: Context.get(this.properties.id),
			update: Context.update(this.properties.id),
			delete: Context.delete(this.properties.id)
		};
		this.users = {
			create: props => {
				props.application_id = this.properties.id;

				return Users.create(props);
			},
			get: user => {
				return Users.get(user, this.properties.id);
			},
			update: Users.update,
			delete: Users.delete
		};
	}

	static async create (props = {}) {
		props.id = props.id || guid.v4();
		let app = new NexxusApplication(props);

		await Services.datasource.dataStorage.createObjects([app.properties]);
		apps.set(props.id, app);

		return app;
	}

	static async retrieveAll () {
		let offset = 0;
		let limit = Services.datasource.dataStorage.config.get_limit;

		(await Services.datasource.dataStorage.searchObjects({ modelName: 'application', offset, limit })).results.forEach(app => {
			apps.set(app.id, new NexxusApplication(app));
		});

		return apps;
	}

	static apps () {
		return apps;
	}

	async update (patches) {
		patches = patches.map((patch, i) => {
			if (patch.field === 'schema' && !(patch.value instanceof ApplicationSchema)) {
				throw new NexxusError('InvalidPatch', `invalid value supplied for schema for patch at index ${i} `);
			}

			patch.value = patch.value.schema;

			return patch;
		});
		let { errors, results } = await Services.datasource.dataStorage.updateObjects(patches);

		if (errors.length) {
			throw errors[0];
		}

		let application = results[0];

		if (!(application instanceof NexxusApplication)) {
			application = new NexxusApplication(application);
		}

		apps.set(this.properties.id, application);
	}

	async delete () {
		let appObj = new Map();

		appObj.set(this.properties.id, { id: this.properties.id, type: 'application' });
		let {errors} = await Services.datasource.dataStorage.deleteObjects(appObj);

		if (errors[0]) {
			throw errors[0];
		}

		apps.delete(this.properties.id);

		let deleteAppObjects = async obj => {
			let deleteObjects = new Map();

			obj.forEach(o => {
				deleteObjects.set(o.id, {id: o.id, type: o.type, application_id: this.properties.id});
			});

			let deleteErrors = (await Services.datasource.dataStorage.deleteObjects(deleteObjects)).errors;

			deleteErrors.forEach(err => {
				Services.logger.warning(err);
			});
		};
		let filter = (new FilterBuilder()).addFilter('is', { application_id: this.properties.id });

		if (this.hasSchema() && this.properties.schema.getModelNames().length) {
			await Services.datasource.dataStorage.searchObjects({ modelName: this.properties.schema.getModelNames(), filters: filter, fields: ['id', 'type'], scanFunction: deleteAppObjects });
		}
	}

	async hasContext (contextId) {
		return (await this.contexts.get(contextId)).properties.application_id === this.properties.id;
	}

	isAPNConfigured () {
		return (this.properties.apn_key && this.properties.apn_key_id && this.properties.apn_team_id && this.properties.apn_topic);
	}

	isGCMCofigured () {
		return !!(this.properties.gcm_api_key);
	}

	setSchema (schemaObject) {
		this.properties.schema = schemaObject;
		schemaObject.applicationId = this.properties.id;
	}

	async updateSchema (schemaObject) {
		let {errors} = await Services.datasource.dataStorage.updateObjects([
			{
				op: 'replace',
				path: `application/${this.properties.id}/schema`,
				value: schemaObject.schema
			}
		]);

		if (errors[0]) {
			throw errors[0];
		}

		await promisify(Services.datastore.cacheStorage.del)(`blg:application:${this.properties.id}`);
	}

	hasModel (modelName) {
		return this.hasSchema() && this.properties.schema.schema[modelName];
	}

	hasSchema () {
		return this.properties.schema instanceof ApplicationSchema;
	}
}

NexxusApplication.models = require('./Model');
NexxusApplication.contexts = {
	get: Context.get(),
	delete: Context.delete(),
	update: Context.update()
};
NexxusApplication.users = require('./User');

module.exports = new Proxy(NexxusApplication, {
	apply: (target, thisArg, argumentList) => {
		if (apps.has(argumentList[0])) {
			return apps.get(argumentList[0]);
		}

		throw new NexxusError('ApplicationNotFound', argumentList[0]);
	}
});
