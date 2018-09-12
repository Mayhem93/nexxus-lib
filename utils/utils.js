const lz4Module = require('lz4');
const stream = require('stream');
const NexxusAdmin = require('../lib/Admin');
const NexxusApplication = require('../lib/Application');
const NexxusContext = require('../lib/Context');
const NexxusUser = require('../lib/User');
const NexxusModel = require('../lib/Model');

/**
 * Transform the object that is sent in the request body in the subscribe endpoint so its compatible with
 * the elasticsearch query object.
 * @param filterObject Object
 * @example
 * <pre>{
  "or": [
	{
	  "and": [
		{
		  "is": {
			"gender": "male",
			"age": 23
		  }
		},
		{
		  "range": {
			"experience": {
			  "gte": 1,
			  "lte": 6
			}
		  }
		}
	  ]
	},
	{
	  "and": [
		{
		  "like": {
			"image_url": "png",
			"website": "png"
		  }
		}
	  ]
	}
  ]
}</pre>
 */
const parseQueryObject = filterObject => {
	let objectKey = Object.keys(filterObject)[0];
	let result = {};

	result[objectKey] = [];

	for (let f in filterObject[objectKey]) {
		let filterObjectKey = Object.keys(filterObject[objectKey][f])[0];
		let filterType = null;

		if (filterObjectKey === 'and' || filterObjectKey === 'or') {
			result[objectKey].push(parseQueryObject(filterObject[objectKey][f]));
			continue;
		}

		switch (filterObjectKey) {
			case 'is': {
				filterType = 'term';
				break;
			}
			case 'like': {
				filterType = 'text';
				break;
			}
			default: {
				let otherFilters = {};

				otherFilters[filterObjectKey] = {};

				for (let prop in filterObject[objectKey][f][filterObjectKey]) {
					otherFilters[filterObjectKey][prop] = filterObject[objectKey][f][filterObjectKey][prop];
				}

				result[objectKey].push(otherFilters);
				continue;
			}
		}

		for (let prop in filterObject[objectKey][f][filterObjectKey]) {
			let p = {};

			p[filterType] = {};
			p[filterType][prop] = filterObject[objectKey][f][filterObjectKey][prop];
			result[objectKey].push(p);
		}
	}

	return result;
};

/**
 * Tests an object against a query object.
 * @param Object object Database item
 * @param Object query The simplified query object (not the elasticsearch one).
 * @returns {boolean}
 */
const testObject = (object, query) => {
	if (typeof object !== 'object') {
		return false;
	}

	if (typeof query !== 'object') {
		return false;
	}

	let mainOperator = Object.keys(query)[0];

	if (mainOperator !== 'and' && mainOperator !== 'or') {
		return false;
	}

	let result = null;
	let partialResult = null;

	function updateResult (result, partial) {
		// if result is not initialised, use the value of the operation
		// otherwise if it had a value from previous operations, combine the previous result with result from
		// the current operation
		return result === null ? partialResult : (mainOperator === 'and') ? result && partialResult : result || partialResult;
	}

	for (let i in query[mainOperator]) {
		if (typeof query[mainOperator][i] != 'object') {
			continue;
		}

		let operation = Object.keys(query[mainOperator][i])[0];

		operationsLoop: // eslint-disable-line no-labels
		for (let property in query[mainOperator][i][operation]) {
			switch (operation) {
				case 'is': {
					partialResult = object[property] === query[mainOperator][i][operation][property];

					break;
				}

				case 'like': {
					partialResult = object[property].toString().search(query[mainOperator][i][operation][property]) !== -1;

					break;
				}

				case 'range': {
					if (typeof query[mainOperator][i][operation][operation][property] !== 'object') {
						continue;
					}

					rangeQueryLoop: // eslint-disable-line no-labels
					for (let rangeOperator in query[mainOperator][i][operation][property]) {
						let objectPropValue = parseInt(object[property]);
						let queryPropValue = parseInt(query[mainOperator][i][operation][property][rangeOperator]);

						switch (rangeOperator) {
							case 'gte': {
								partialResult = objectPropValue >= queryPropValue;

								break;
							}

							case 'gt': {
								partialResult = objectPropValue > queryPropValue;

								break;
							}

							case 'lte': {
								partialResult = objectPropValue <= queryPropValue;

								break;
							}

							case 'lt': {
								partialResult = objectPropValue < queryPropValue;

								break;
							}

							default: {
								continue rangeQueryLoop; // eslint-disable-line no-labels
							}
						}

						result = updateResult(result, partialResult);
					}

					break;
				}

				case 'or':
				case 'and': {
					partialResult = testObject(object, query[mainOperator][i]);

					break;
				}

				default: {
					continue operationsLoop; // eslint-disable-line no-labels
				}
			}

			result = updateResult(result, partialResult);
		}
	}

	return !!result;
};

const lz4 = ((() => {
	/**
	 * @callback lz4ResultCb
	 * @param {Buffer} result The result of compression/decompression
	 */
	/**
	 * Only used internally to avoid code dupe
	 * @param {string|Buffer} data
	 * @param {int} operation 0 for compression, 1 for decompression
	 * @param {lz4ResultCb} callback
	 */
	const doWork = async (data, operation) => {
		const result = await (new Promise((resolve, reject) => {
			let lz4Stream = null;

			if (operation === 0) {
				lz4Stream = lz4Module.createEncoderStream();
			} else if (operation === 1) {
				lz4Stream = lz4Module.createDecoderStream();
			}

			let outputStream = new stream.Writable();
			let result = Buffer.alloc(0);

			outputStream._write = (chunk, encoding, callback1) => {
				result = Buffer.concat([result, chunk]);
				callback1();
			};

			outputStream.on('finish', () => {
				resolve(result);
			});

			let inputStream = new stream.Readable();

			inputStream.push(data);
			inputStream.push(null);

			inputStream.pipe(lz4Stream).pipe(outputStream);
		}));

		return result;
	};

	return {
		/**
		 * LZ4 compress a string
		 * @param {string} data
		 * @param {lz4ResultCb} callback
		 */
		compress (data) {
			return doWork(data, 0);
		},
		/**
		 * LZ4 decompress a string
		 * @param {Buffer} data
		 * @param {lz4ResultCb} callback
		 */
		decompress (data) {
			return doWork(data, 1);
		}
	};
}))();

const getProperModel = object => {
	switch (object.type) {
		case 'admin': {
			return new NexxusAdmin(object);
		}
		case 'application': {
			return new NexxusApplication(object);
		}
		case 'context': {
			return new NexxusContext(object);
		}
		case 'user': {
			return new NexxusUser(object);
		}
		default: {
			return new NexxusModel(object);
		}
	}
};

module.exports = {
	parseQueryObject,
	getProperModel,
	testObject,
	lz4
};
