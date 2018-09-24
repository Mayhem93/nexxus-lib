const constants = require('./constants');
const NexxusError = require('./NexxusError');
const NexxusApplicationSchema = require('./ApplicationSchema');
const {diff, detailedDiff} = require('deep-object-diff');
const clone = require('clone');

class NexxusPatch {
	constructor (objectPatch, applicationId = undefined) {
		this.op = objectPatch.op.toString();
		this.path = objectPatch.path.toString();
		[this.model, this.id, this.field] = this.path.split('/');

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
		const originalProps = clone(object.properties);

		patches.forEach(patch => {
			if (object.isImmutable(patch.field)) {
				throw new NexxusError('InvalidPatch', `unable to carry operation on immutable property "${patch.field}"`);
			}

			switch (patch.op) {
				case 'replace': {
					if (patch.field === 'schema' && !(patch.value instanceof NexxusApplicationSchema)) {
						object.properties[patch.field] = new NexxusApplicationSchema(patch.value);
					} else {
						object.properties[patch.field] = patch.value;
					}

					break;
				}

				case 'increment': {
					object.properties[patch.field] += patch.value;

					break;
				}

				case 'append': {
					if (Array.isArray(object.properties[patch.field])) {
						object.properties[patch.field].push(patch.value);
					} else if (typeof object.properties[patch.field] == 'string') {
						object.properties[patch.field] += patch.value;
					} else if (object.properties[patch.field] === undefined) {
						object.properties[patch.field] = [patch.value];
					}

					break;
				}

				case 'remove': {
					if (Array.isArray(object.properties[patch.field])) {
						let idx = object.properties[patch.field].indexOf(patch.value);

						if (idx !== -1) {
							object.properties[patch.field].splice(idx, 1);
						}
					}

					break;
				}
			}
		});

		const objectPropsClone = clone(object.properties);

		if (object.properties.type === 'application') {
			originalProps.schema = originalProps.schema.schema;
			objectPropsClone.schema = objectPropsClone.schema.schema;
		}

		let objectDiff = diff(originalProps, objectPropsClone);
		let filteredDiff = {};

		Object.keys(objectDiff).forEach((field, value) => {
			if (value !== undefined) {
				filteredDiff[field] = value;
			}
		});

		return {
			diff: filteredDiff, detailedDiff: detailedDiff(originalProps, objectPropsClone)
		};
	}
}

module.exports = NexxusPatch;
