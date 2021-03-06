const common = require('../../common');
const chai = require('chai');
const expect = chai.expect;
const clone = require('clone');

chai.should();
chai.use(require('chai-things'));

const sinon = require('sinon');
const EsAdapter = require('../../../lib/database/adapters/elasticsearch_adapter');
const NexxusError = require('../../../lib/NexxusError');
const NexxusLogger = require('../../../lib/logger/logger');

module.exports = function Constructor () {
	describe('ElasticSearchDB.constructor', () => {
		it('Should fail because configuration parameter is missing or not valid param', done => {
			try {
				EsAdapter();
			} catch (e) {
				expect(e).to.be.instanceof(NexxusError);
				expect(e.code).to.equal('002');
			}

			try {
				EsAdapter({});
			} catch (e) {
				expect(e).to.be.instanceof(NexxusError);
				expect(e.code).to.equal('002');
			}

			done();
		});

		it('Should connect to a real server with the correct configuration param ', done => {
			const esConfig = clone(common.config.ElasticSearch1);
			const infoLogSpy = sinon.spy(NexxusLogger.prototype, 'info');
			let client;

			try {
				client = new EsAdapter(esConfig);

				expect(client.config.host).to.be.equal(esConfig.host);
				expect(client.config.hosts).to.be.undefined;

				client.once('ready', () => {
					infoLogSpy.restore();
					sinon.assert.calledOnce(infoLogSpy);
					sinon.assert.calledWith(infoLogSpy, 'Connected to ElasticSearch MainDatabase');

					done();
				});
			} catch (e) {
				expect(e).to.be.undefined; // disable-eslint-rule no-unused-expressions
			}
		});

		it('Shouldn\'t connect to a server because host timed out', done => {
			const esConfig = clone(common.config.ElasticSearch1);

			esConfig.host = '127.0.0.2:9200';
			const infoLogSpy = sinon.spy(NexxusLogger.prototype, 'info');
			const errorLogSpy = sinon.spy(NexxusLogger.prototype, 'error');
			let client;

			try {
				client = new EsAdapter(esConfig);
			} catch (e) {
				expect(e).to.be.undefined;
			}

			expect(client.config.host).to.be.equal(esConfig.host);
			expect(client.config.hosts).to.be.undefined;

			setTimeout(() => {
				infoLogSpy.restore();
				errorLogSpy.restore();

				sinon.assert.notCalled(infoLogSpy);
				sinon.assert.called(errorLogSpy);

				done();
			}, 3000);
		});

		it('Should connect using hosts config parameter', done => {
			const esConfig = clone(common.config.ElasticSearch2);
			const infoLogSpy = sinon.spy(NexxusLogger.prototype, 'info');
			let client;

			try {
				client = new EsAdapter(esConfig);
				expect(client.config.hosts).to.deep.equal(esConfig.hosts);
				expect(client.config.host).to.be.undefined;

				client.once('ready', () => {
					infoLogSpy.restore();

					sinon.assert.calledWith(infoLogSpy, 'Connected to ElasticSearch MainDatabase');

					done();
				});
			} catch (e) {
				expect(e).to.be.undefined;
			}
		});
	});
};
