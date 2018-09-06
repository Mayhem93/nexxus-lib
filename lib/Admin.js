const guid = require('uuid');
const NexxusError = require('./NexxusError');
const BaseModel = require('./BaseModel');
const Services = require('./Services');

class Admin extends BaseModel {
	constructor (props) {
		props.id = props.id || guid.v4();
		props.type = 'admin';

		super(props);
	}

	static async create (props) {
		let newAdmin = new Admin(props);

		const {errors} = await Services.datasource.dataStorage.createObjects([newAdmin.properties]);

		if (errors[0]) {
			throw errors[0];
		}

		return newAdmin;
	}

	static async get (id) {
		const { errors, results } = await Services.datasource.dataStorage.getObjects([id]);

		if (errors[0]) {
			throw errors[0];
		}

		return new Admin(results[0]);
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
