var common = require('../../common');
var chai = require('chai');
var expect = chai.expect;
var assert = chai.assert;
var clone = require('clone');
chai.should();
chai.use(require('chai-things'));

var sinon = require('sinon');
var TelepatError = require('../../../lib/TelepatError');
var FilterBuilder = require('../../../utils/filterbuilder').FilterBuilder;

module.exports = function getQueryObject() {
	describe('ElasticSearchDB.getQueryObject', function() {
		it('Should fail because function called with invalid argument', function(done) {
			try {
				var ret = esAdapterConnection.getQueryObject(undefined);
				assert.fail(ret, undefined, 'method should throw error');
			} catch(e) {
				expect(e).to.be.instanceof(TelepatError);
				expect(e).to.have.property('code', '002');
				done();
			}
		});

		it('Should return ElasticSearch query for a simple query', function(done) {
			var fb = new FilterBuilder();
			fb.addFilter('is', {user_id: 1});

			var result = esAdapterConnection.getQueryObject(fb);
			expect(result).to.be.deep.equal({and: [{term: {user_id: 1}}]});

			done();
		});

		it('Should return ElasticSearch query with all the available filters', function(done) {
			var fb = new FilterBuilder('or');
			fb.addFilter('is', {a: 0})
				.addFilter('not', {is: {b: 1}})
				.addFilter('exists', 'c')
				.addFilter('range', {d: {gt: 100}})
				.addFilter('range', {e: {gte: 101}})
				.addFilter('range', {f: {lt: 200}})
				.addFilter('range', {g: {lte: 190}})
				.addFilter('range', {h: {gte: 100, lte: 200}})
				.addFilter('in_array', {i: 'value'})
				.addFilter('in_array', {j: ['abc', 'xyz']})
				.addFilter('like', {k: 'text'});

			var result = esAdapterConnection.getQueryObject(fb);
			expect(result).to.be.deep.equal({
				or: [
					{
						term: {
							a: 0
						}
					},
					{
						not: {
							term: {
								b: 1
							}
						}
					},
					{
						exists: {
							field: 'c'
						}
					},
					{
						range: {
							d: {
								gt: 100
							}
						}
					},
					{
						range: {
							e: {
								gte: 101
							}
						}
					},
					{
						range: {
							f: {
								lt: 200
							}
						}
					},
					{
						range: {
							g: {
								lte: 190
							}
						}
					},
					{
						range: {
							h: {
								gte: 100,
								lte: 200
							}
						}
					},
					{
						terms: {
							i: ['value']
						}
					},
					{
						terms: {
							j: ['abc', 'xyz']
						}
					},
					{
						regexp: {
							k: '.*text.*'
						}
					}
				]
			});

			done();
		});
	});
};
