const Application = require('./Application');
const NexxusError = require('./NexxusError');
const FilterBuilder = require('../utils/filterbuilder').FilterBuilder;
const constants = require('./constants');
const Services = require('./Services');
const BaseModel = require('./BaseModel');

class Model extends BaseModel {
	constructor (props) {
		if (!Application(props.application_id).hasModel(props.type)) {
			throw new NexxusError('ApplicationSchemaModelNotFound', props.type);
		}

		super(props, ['context_id', 'application_id', 'user_id']);
	}

	static async get (id) {
		const {errors, results} = await Services.datasource.dataStorage.getObjects([id]);

		if (errors[0]) {
			throw errors[0];
		}

		return new Model(results[0].properties);
	}

	static async create (objects) {
		objects = objects.map(object => new Model(object));

		const {errors} = await Services.datasource.dataStorage.createObjects(objects.map(object => object.properties));

		return {errors, objects};
	}

	static update (patches) {
		let appModelsPatches = [];

		patches.forEach(p => {
			let modelType = p.path.split('/')[0];

			if (!constants.builtinModels[modelType]) {
				appModelsPatches.push(p);
			} else {
				Services.logger.warning('Cannot update builtin model', modelType);
			}
		});

		return Services.datasource.dataStorage.updateObjects(appModelsPatches);
	}

	static async delete (objects, callback) {
		let appModels = {};

		for (let id of objects) {
			if (!constants.builtinModels[objects[id]]) {
				appModels[id] = objects[id];
			} else {
				Services.logger.warning('Cannot delete builtin model', objects[id]);
			}
		}

		const { errors } = await Services.datasource.dataStorage.deleteObjects(appModels);

		return errors;
	}

	static count (appId, modelName) {
		let filter = new FilterBuilder();

		filter.addFilter('is', { application_id: appId });

		return Services.datasource.dataStorage.countObjects({ modelName, filters: filter });
	}

	static getFilterFromChannel (channel) {
		let searchFilters = new FilterBuilder();

		searchFilters.addFilter('is', { application_id: channel.appId });

		if (channel.props.context) {
			searchFilters.addFilter('is', { context_id: channel.props.context });
		}
		if (channel.props.user) {
			searchFilters.addFilter('is', { user_id: channel.props.user });
		}

		if (channel.props.parent) {
			let filterObj = {};

			filterObj[`${channel.props.parent.model}_id`] = channel.props.parent.id;
			searchFilters.addFilter('is', filterObj);
		}

		if (channel.filter) {
			(function AddFilters (filterObject) {
				let filterKey = Object.keys(filterObject);

				if (filterKey === 'or') {
					searchFilters.or();
				} else if (filterKey === 'and') {
					searchFilters.and();
				}

				filterObject[filterKey].forEach((filters, key) => {
					if (key === 'and' || key === 'or') {
						AddFilters(filterObject[filterKey]);
					} else {
						for (let key2 in filters) {
							if (key2 === 'and' || key2 === 'or') {
								AddFilters(filters);
							} else {
								searchFilters.addFilter(key2, filters[key2]);
							}
						}
					}
				});
				searchFilters.end();
			})(channel.filter);
		}

		return searchFilters;
	}

	static modelCountByChannel (channel, aggregation) {
		let filters = Model.getFilterFromChannel(channel);

		return Services.datasource.dataStorage.countObjects({ modelName: channel.props.model, filters, aggregation });
	}

	static search (channel, sort, offset, limit) {
		let searchFilters = Model.getFilterFromChannel(channel);

		return Services.datasource.dataStorage.searchObjects({
			filters: searchFilters,
			modelName: channel.props.model,
			sort,
			offset,
			limit
		});
	}

	/* static getParentInfo (object) {
		let appId = object.application_id;
		let modelName = object.type;
		let validationCheck = Application.apps[appId].modelSchema(modelName).isValidModel();

		if (validationCheck instanceof NexxusError) {
			return validationCheck;
		}

		let appModels = Application.apps[appId].schema;
		let parent, relationType;

		if (!appModels[modelName].belongsTo) {
			return null;
		}

		for (let r in appModels[modelName].belongsTo) {
			if (object[appModels[modelName].belongsTo[r].parentModel + '_id']) {
				parent = {
					model: appModels[modelName].belongsTo[r].parentModel,
					id: object[appModels[modelName].belongsTo[r].parentModel + '_id']
				};
				relationType = appModels[modelName].belongsTo[r].relationType;
			}
		}

		let objParentInfo;

		if (parent) {
			let parentRelationKey;

			if (relationType === 'hasSome') {
				parentRelationKey = object[Model.hasSome({ type: parent.model, application_id: appId }) + 'index'];
			}

			if (!parentRelationKey && Application.apps[appId].modelSchema(parent.model).hasSome(object.type)) {
				return (new NexxusError(NexxusError.errors.MissingRequiredField, [parent.parentRelationKey]));
			}

			objParentInfo = {
				model: parent.model,
				parentRelationKey: parentRelationKey,
				id: parent.id
			};
		}

		return objParentInfo;
	} */

	/* static validateObject (content) {
		let parent = Model.getParentInfo(content);

		if (parent instanceof NexxusError) {
			return parent;
		}

		if (parent) {
			if (parent.parentRelationKey && !content[parent.parentRelationKey]) {
				return (new NexxusError(NexxusError.errors.MissingRequiredField, [parent.parentRelationKey]));
			}

			if (parent.id) {
				return true;
			}

			return new NexxusError(NexxusError.errors.MissingRequiredField, ['id']);
		}

		return true;
	} */
}

module.exports = Model;
