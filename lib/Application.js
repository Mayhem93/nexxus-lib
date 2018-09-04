const BaseModel = require('./BaseModel');
const guid = require('uuid');
const Services = require('./Services');
const FilterBuilder = require('../utils/filterbuilder').FilterBuilder;
const NexxusError = require('./NexxusError');
const Context = require('./Context');
const Users = require('./User');
const ApplicationSchema = require('./ApplicationSchema');
const promisify = require('util').promisify;

const apps = {};

class NexxusApplication extends BaseModel {
	constructor (props) {
		props.admins = Array.isArray(props.admins) ? props.admins : [];
		props.keys = Array.isArray(props.keys) ? props.keys : [];
		props.type = 'application';
		if (props.schema) {
			props.schema = new ApplicationSchema(props.schema);
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

	static async create (props) {
		props.id = props.id || guid.v4();
		let app = new NexxusApplication(props);

		await Services.datasource.dataStorage.createObjects([app.properties]);
		apps[props.id] = app;

		return app;
	}

	async delete () {
		let appObj = {[this.properties.id]: 'application'};
		let {errors} = await Services.datasource.dataStorage.deleteObjects(appObj);

		if (errors[0]) {
			throw errors[0];
		}

		delete apps[this.properties.id];

		let deleteAppObjects = async obj => {
			let deleteObjects = {};

			obj.forEach(o => {
				deleteObjects[o.id] = o.type;
			});

			let deleteErrors = (await Services.datasource.dataStorage.deleteObjects(deleteObjects)).errors;

			deleteErrors.forEach(err => {
				Services.logger.warning(err);
			});
		};
		let filter = (new FilterBuilder()).addFilter('is', { application_id: this.properties.id });

		await Services.datasource.dataStorage.searchObjects({ filters: filter, fields: ['id', 'type'], scanFunction: deleteAppObjects });
		await promisify(Services.redisClient.del)(`blg:application:${this.properties.id}`);
	}

	async update (patches) {
		let {errors, results} = await Services.datasource.dataStorage.updateObjects(patches);

		if (errors.length) {
			throw errors[0];
		}

		let application = results[this.properties.id];

		if (!(application instanceof NexxusApplication)) {
			application = new NexxusApplication(application);
		}

		apps[this.properties.id] = application;
		await promisify(Services.redisClient.del)(`blg:application:${this.properties.id}`);
	}

	static async getAll () {
		let offset = 0;
		let limit = Services.datasource.dataStorage.config.get_limit;

		(await Services.datasource.dataStorage.searchObjects({ modelName: 'application', offset, limit })).forEach(app => {
			apps[app.id] = new NexxusApplication(app);
		});

		return apps;
	}

	async hasContext (contextId) {
		return (await Context.get(contextId)).application_id === this.properties.id;
	}

	static isAdmin (admin) {
		for (let id in apps) {
			if (apps[id].admins.indexOf(admin.id) !== -1) {
				return true;
			}
		}

		return false;
	}

	isAPNConfigured () {
		return (this.properties.apn_key && this.properties.apn_key_id && this.properties.apn_team_id && this.properties.apn_topic);
	}

	isGCMCofigured () {
		return !!(this.properties.gcm_api_key);
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

		await promisify(Services.redisClient.del)(`blg:application:${this.properties.id}`);
	}

	async deleteModel (modelName) {
		if (!this.hasSchema()) {
			throw new NexxusError('ApplicationSchemaModelNotFound', [this.properties.id, modelName]);
		}

		delete apps[this.properties.id].schema[modelName];
		const {errors} = await Services.datasource.dataStorage.updateObjects([
			{
				op: 'replace',
				path: `application/${this.properties.id}/schema`,
				value: this.properties.schema.schema
			}
		]);

		if (errors[0]) {
			throw errors[0];
		}

		await promisify(Services.redisClient.del)(`blg:application:${this.properties.id}`);
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
		if (apps[argumentList[0]]) {
			return apps[argumentList[0]];
		}

		throw new NexxusError('ApplicationNotFound', argumentList[0]);
	}
});
