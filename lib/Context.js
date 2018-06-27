const FilterBuilder = require('../utils/filterbuilder').FilterBuilder;
const guid = require('uuid');
const BaseModel = require('./BaseModel');
const NexxusErrorCollection = require('./NexxusErrorCollection');
const Services = require('./Services');

class NexxusContext extends BaseModel {
	constructor (props) {
		const proxiedParent = super(props, ['application_id']);

		return proxiedParent;
	}

	static get () {
		return async id => {
			const {errors, results} = await Services.datasource.dataStorage.getObjects([id]);

			if (errors) {
				throw new NexxusErrorCollection(errors);
			}

			return new NexxusContext(results[0]);
		};
	}

	static getAll (appId) {
		return async () => {
			let filter = null;
			let limit = Services.datasource.dataStorage.config.get_limit;

			if (appId) {
				filter = (new FilterBuilder('and')).addFilter('is', { application_id: appId });
			}

			return (await Services.datasource.dataStorage.searchObjects({ modelName: 'context', filters: filter, offset: 0, limit })).results;
		};
	}

	static new (appId) {
		return async props => {
			props.id = guid.v4();
			props.type = 'context';
			props.application_id = appId;

			let createdContext = new NexxusContext(props);

			const {errors} = await Services.datasource.dataStorage.createObjects([createdContext]);

			if (errors.length) {
				throw errors[0];
			}

			return createdContext;
		};
	}

	static delete () {
		return async id => {
			let delObj = {};

			delObj[id] = 'context';

			let {errors} = await Services.datasource.dataStorage.deleteObjects(delObj);

			if (errors.length) {
				throw errors[0];
			}

			const deleteContextObjects = async obj => {
				let deleteObjects = {};

				obj.each(o => {
					deleteObjects[o.id] = o.type;
				});

				const {errors} = await Services.datasource.dataStorage.deleteObjects(deleteObjects);

				errors.forEach(err => {
					Services.logger.warning(`Removing context with id ${id} partially failed: ${err.message}`);
				});
			};

			let filter = (new FilterBuilder()).addFilter('is', { context_id: id });

			await Services.datasource.dataStorage.searchObjects({ filters: filter, fields: ['id', 'type'], scanFunction: deleteContextObjects });
		};
	}

	static update () {
		return async patches => {
			const {errors} = await Services.datasource.dataStorage.updateObjects(patches);

			if (errors.length) {
				throw errors[0];
			}
		};
	}
}

module.exports = NexxusContext;
