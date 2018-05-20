const common = require('../../common');
const clone = require('clone');
const es = require('elasticsearch');
const EsAdapter = require('../../../lib/database/elasticsearch_adapter');

/**
 * @global
 */
let esConfig = common.config.ElasticSearch1;

/**
 *	@global
 * 	@param {Function} done
 */
let esConnection = new es.Client(clone(common.config.ElasticSearch1));

/**
 * @global
 */
esAdapterConnection = new EsAdapter(clone(common.config.ElasticSearch1));

const tests = [
	require('./constructor'),
	require('./getObjects'),
	require('./createObjects'),
	require('./updateObjects'),
	require('./deleteObjects'),
	require('./getQueryObject')
];

tests.forEach(t => {
	t();
});
