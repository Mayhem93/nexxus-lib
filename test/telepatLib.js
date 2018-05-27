const common = require('./common');
const es = require('elasticsearch');
const clone = require('clone');
const esConnection = new es.Client(clone(common.config.ElasticSearch1));
const Application = require('../lib/Application');
const TelepatLogger = require('../lib/logger/logger');
const path = require('path');

Application.logger = new TelepatLogger({
	type: 'Console',
	name: 'telepat-models-tests',
	settings: {level: 'debug'}
});

const tests = [
	{
		name: 'index',
		path: 'index.js'
	},
	{
		name: 'Filter builder',
		path: 'utils/filterbuilderTests.js'
	},
	{
		name: 'ElasticSearch',
		path: 'database/elasticsearch/elasticsearchTests.js',
		cleanup: callback => {
			esConnection.indices.delete({index: common.config.ElasticSearch1.index}, err => {
				if (err) {
					console.log(err);
				}

				callback();
			});
		},
		before: callback => {
			esConnection.indices.exists({index: common.config.ElasticSearch1.index}, (err, exists) => {
				if (err) {
					return callback(err);
				}
				if (!exists) {
					return esConnection.indices.create({index: common.config.ElasticSearch1.index}, err => {
						if (err) {
							console.trace(err);
						}

						callback();
					});
				}

				return callback();
			});
		}
	}
];

describe('Telepat Models', () => {
	tests.forEach((t, i) => {
		describe(`${(i + 1)}. ${t.name}`, function () {
			if (t.before && t.before instanceof Function) {
				before(done => {
					setTimeout(() => {
						t.before(done);
					}, 1000);
				});
			}

			this.timeout(10000);

			require(path.join(__dirname, t.path));
			console.log(__dirname, t.path);

			if (t.cleanup && t.cleanup instanceof Function) {
				after(t.cleanup);
			}
		});
	});
});
