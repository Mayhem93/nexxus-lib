const constants = require('./constants');
const NexxusError = require('./NexxusError');

class NexxusPatch {
	constructor (objectPatch, applicationId = undefined) {
		this.op = objectPatch.op.toString();
		this.path = objectPatch.path.toString();
		[[this.model], [this.id], [this.field]] = objectPatch.patch.path.split('/');

		if (!this.model || !this.id || !this.field) {
			throw new NexxusError('InvalidPatch', `path "${this.path}" is malformed`);
		}

		this.value = objectPatch.value;
		this.applicationId = applicationId;

		if (!constants.patch.OP[this.op]) {
			throw new NexxusError('InvalidPatch', `operation "${this.op}" not supported`);
		}
	}

	static applyPatches (patches, object) {
		patches.forEach(patch => {
			if (object.isImmutable(patch.field)) {
				throw new NexxusError('InvalidPatch', `unable to carry operation on immutable property "${patch.field}"`);
			}

			switch (patch.op) {
				case 'replace': {
					object.props[patch.field] = patch.value;

					break;
				}

				case 'increment': {
					object[patch.field] += patch.value;

					break;
				}

				case 'append': {
					if (Array.isArray(object[patch.field])) {
						object[patch.field].push(patch.value);
					} else if (typeof object[patch.field] == 'string') {
						object[patch.field] += patch.value;
					} else if (object[patch.field] === undefined) {
						object[patch.field] = [patch.value];
					}

					break;
				}

				case 'remove': {
					if (Array.isArray(object[patch.field])) {
						let idx = object[patch.field].indexOf(patch.value);

						if (idx !== -1) {
							object[patch.field].splice(idx, 1);
						}
					}

					break;
				}
			}
		});

		return object;
	}
}

exports = NexxusPatch;
