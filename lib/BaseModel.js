const NexxusError = require('./NexxusError');
const constants = require('./constants');
const uuid = require('uuid');

let immutableProperties = {};

constants.models.BaseModel.reservedFieldNames.forEach(fieldName => {
	immutableProperties[fieldName] = true;
});

class BaseModel {
	constructor (props, moreImmutableProps) {
		if (typeof props.type !== 'string') {
			throw new NexxusError('MissingRequiredField', ['type']);
		}

		moreImmutableProps.forEach(prop => {
			immutableProperties[prop] = true;
		});
		this.properties = props;
		this.properties.id = this.properties.id || uuid.v4();
		this.properties.created = this.properties.created || parseInt(Date.now() / 1000);
		this.properties.modified = this.properties.modified || this.properties.created;

		this.properties = new Proxy(this.properties, {
			set: (object, property, value) => {
				if (immutableProperties[property]) {
					return false;
				}

				object[property] = value;
				object.modified = parseInt(Date.now() / 1000);

				return true;
			},
			get: (object, property) => object[property]
		});
	}

	isImmutable (prop) {
		return immutableProperties[prop];
	}

	set immutableProperties (newProperties) {
		immutableProperties = newProperties;
	}

	get immutableProperties () {
		return immutableProperties;
	}
}

module.exports = BaseModel;
