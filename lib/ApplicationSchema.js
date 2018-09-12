const NexxusError = require('./NexxusError');
const constants = require('./constants');
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
		for (const model in schema) {
			if (constants.builtinModels.indexOf(model) !== -1) {
				throw new NexxusError('InvalidApplicationSchema', `Application model name "${model} is reserved"`);
			}

			if (!schema[model].properties) {
				throw new NexxusError('InvalidApplicationSchema', `Application model "${model}" is missing properties`);
			}

			for (const field in schema[model].properties) {
				if (!schema[model].properties[field].type) {
					throw new NexxusError('InvalidApplicationSchema', `Application model "${model}" is missing type for field "${field}"`);
				}
				if (!constants.models.fieldTypes[schema[model].properties[field].type]) {
					throw new NexxusError('InvalidApplicationSchema',
						`Invalid type "${schema[model].properties[field].type}" for field "${field}" in Application model "${model}"`);
				}
				if (allReservedFields.indexOf(field) !== -1) {
					throw new NexxusError('InvalidApplicationSchema', `Field "${field}" for model "${model}" is reserved`);
				}
			}
		}
	}

	deleteModel (modelName) {
		if (!this.schema[modelName]) {
			throw new NexxusError('ApplicationSchemaModelNotFound', modelName);
		}
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
