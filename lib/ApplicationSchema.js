const NexxusError = require('./NexxusError');
const Services = require('./Services');
const constants = require('./constants');
const promisify = require('util').promisify;

const validate = Symbol('validate private merhod');

let allReservedFields = constants.models.BaseModel.reservedFieldNames;

allReservedFields = allReservedFields.concat(constants.models.Application.reservedFieldNames,
	constants.models.Context.reservedFieldNames,
	constants.models.ApplicationModel.reservedFieldNames);

class ApplicationSchema {
	constructor (schema) {
		this[validate](schema);
		this.schema = schema;
	}

	[validate] (schema) {
		for (const modelName in schema) {
			if (/[^a-z0-9_]/gm.test(modelName)) {
				throw new NexxusError('InvalidApplicationSchema', `Application model name "${modelName}" should only contain lower-cased alphanumberic
					characters and undescores`);
			}

			if (constants.builtinModels.indexOf(modelName) !== -1) {
				throw new NexxusError('InvalidApplicationSchema', `Application model name "${modelName} is reserved"`);
			}

			if (!schema[modelName].properties) {
				throw new NexxusError('InvalidApplicationSchema', `Application model "${modelName}" is missing properties`);
			}

			for (const field in schema[modelName].properties) {
				if (!schema[modelName].properties[field].type) {
					throw new NexxusError('InvalidApplicationSchema', `Application model "${modelName}" is missing type for field "${field}"`);
				}
				if (!constants.models.fieldTypes[schema[modelName].properties[field].type]) {
					throw new NexxusError('InvalidApplicationSchema',
						`Invalid type "${schema[modelName].properties[field].type}" for field "${field}" in Application model "${modelName}"`);
				}
				if (allReservedFields.indexOf(field) !== -1) {
					throw new NexxusError('InvalidApplicationSchema', `Field "${field}" for model "${modelName}" is reserved`);
				}
			}
		}
	}

	getModelNames () {
		return Object.keys(this.schema);
	}

	async deleteModel (modelName) {
		delete this.schema[modelName];

		const { errors } = await Services.datasource.dataStorage.updateObjects([
			{
				op: 'replace',
				path: `application/${this.applicationId}/schema`,
				value: this.schema
			}
		]);

		if (errors[0]) {
			throw errors[0];
		}

		await promisify(Services.datastore.cacheStorage.del)(`blg:application:${this.properties.id}`);
	}

	belongsTo (modelName, parentName) {
		if (this.schema[modelName].belongsTo) {
			return !!this.schema[modelName].belongsTo.find(parent => parent.parentModel === parentName);
		}

		return false;
	};

	hasParent (modelName, modelParent) {
		if (!this.schema[modelName].belongsTo) {
			return false;
		}

		if (!this.schema[modelParent]) {
			return false;
		}

		let relationType = this.schema[modelName].belongsTo.relationType;

		if (this.schema[modelParent].belongsTo.parentModel !== modelName) {
			return false;
		}

		if (relationType) {
			if (this.schema[modelParent][relationType].indexOf(modelName) === -1) {
				return false;
			}
		}

		return true;
	};

	hasMany (modelName, modelParent) {
		return (this.schema[modelName].hasMany.indexOf(modelParent) !== -1);
	};
}

module.exports = ApplicationSchema;
