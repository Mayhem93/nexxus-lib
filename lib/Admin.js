const FilterBuilder = require('../utils/filterbuilder').FilterBuilder;
const guid = require('uuid');
const NexxusError = require('./NexxusError');
const BaseModel = require('./BaseModel');
const Services = require('./Services');

class Admin extends BaseModel {
	constructor (props) {
		props.id = props.id || guid.v4();
		props.type = 'admin';

		super(props, ['application_id']);
	}

	static async new (props) {
		let newAdmin = new Admin(props);

		const {errors} = await Services.datasource.dataStorage.createObjects([newAdmin.properties]);

		if (errors[0]) {
			throw errors[0];
		}

		return newAdmin;
	}

	static async get (admin, callback) {
		if (admin.id) {
			const {errors, results} = await Services.datasource.dataStorage.getObjects([admin.id]);

			if (errors[0]) {
				throw errors[0];
			}

			return new Admin(results[0]);
		} else if (admin.email) {
			let filter = new FilterBuilder();

			filter.addFilter('is', {email: admin.email});
			const results = await Services.datasource.dataStorage.searchObjects({modelName: 'admin', filters: filter});

			if (!results.length) {
				throw new NexxusError(NexxusError.errors.AdminNotFound);
			}

			return new Admin(results[0]);
		}

		return null;
	}

	static async delete (id) {
		const {errors} = await Services.datasource.dataStorage.deleteObjects({[id]: 'admin'});

		if (errors[0]) {
			if (errors[0].name === NexxusError.errors.ObjectNotFound) {
				throw new NexxusError(NexxusError.errors.AdminNotFound);
			}

			throw errors[0];
		}
	}

	static async update (patches) {
		const {errors} = await Services.datasource.dataStorage.updateObjects(patches);

		if (errors[0]) {
			if (errors[0].name === NexxusError.errors.ObjectNotFound) {
				throw new NexxusError(NexxusError.errors.AdminNotFound);
			}

			throw errors[0];
		}
	}
}

module.exports = Admin;
