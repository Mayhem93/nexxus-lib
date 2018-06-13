const TelepatError = require('./TelepatError');

let immutableProperties = {
	id: true,
	created: true,
	modified: true,
	type: true
};

class BaseModel {
	constructor (props, moreImmutableProps) {
		if (typeof props.type !== 'string') {
			throw new TelepatError('MissingRequiredField', ['type']);
		}

		moreImmutableProps.forEach(prop => {
			immutableProperties[prop] = true;
		});
		this.properties = props;
		this.properties.created = this.properties.created || parseInt(Date.now() / 1000);
		this.properties.modified = this.properties.modified || this.properties.created;

		return new Proxy(this, {
			set: (object, property, value) => {
				if (immutableProperties[property]) {
					return false;
				}

				object.properties[property] = value;
				object.properties.modified = parseInt(Date.now() / 1000);

				return true;
			},
			get: (object, property) => {
				if (property === 'properties') {
					return object.properties;
				}

				return object.properties[property] || object[property] || undefined;
			}
		});
	}

	serialize () {
		return this.properties;
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
