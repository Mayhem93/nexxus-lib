class Delta {
	constructor (fields, subscriptions) {
		this.op = fields.op;
		this.object = fields.object;
		this.patch = fields.patch;
		this.application_id = fields.application_id;
		this.timestamp = fields.timestamp;
		if (this.instant) {
			this.instant = fields.instant;
		}
		this.subscriptions = subscriptions || [];
	}

	toObject () {
		let obj = {
			op: this.op,
			object: this.object,
			subscriptions: this.subscriptions,
			application_id: this.application_id,
			timestamp: this.timestamp
		};

		if (this.op === 'update') {
			obj.patch = this.patch;
		}

		if (this.instant) {
			obj.instant = true;
		}

		return obj;
	}

	static formPatch (object, op, property) {
		let patch = {};

		if (op) {
			patch.op = op;
		}

		if (property) {
			let prop = Object.keys(property)[0];

			patch.path = `${object.type}/${object.id}/${prop}`;
			patch.value = property[prop];
		} else if (object.id) {
			patch.path = `${object.type}/${object.id}`;
		}

		return patch;
	}
}

/**
 * @enum {string}
 * @type {{ADD: string, UPDATE: string, DELETE: string}}
 */
Delta.OP = {
	ADD: 'add',
	UPDATE: 'update',
	DELETE: 'delete'
};

module.exports = Delta;
