const common = require('../../common');
const chai = require('chai');
const expect = chai.expect;
const clone = require('clone');

chai.should();
chai.use(require('chai-things'));

const sinon = require('sinon');
const EsAdapter = require('../../../lib/database/elasticsearch_adapter');
const TelepatError = require('../../../lib/TelepatError');
const TelepatLogger = require('../../../lib/logger/logger');

module.exports = function Constructor () {
	describe('ElasticSearchDB.constructor', () => {
		it('Should fail because configuration parameter is missing or not valid param', done => {
			try {
				EsAdapter();
			} catch (e) {
				expect(e).to.be.instanceof(TelepatError);
				expect(e.code).to.equal('002');
			}

			try {
				EsAdapter({});
			} catch (e) {
				expect(e).to.be.instanceof(TelepatError);
				expect(e.code).to.equal('002');
			}

			done();
		});

		it('Should connect to a real server with the correct configuration param ', done => {
			const esConfig = clone(common.config.ElasticSearch1);
			const infoLogSpy = sinon.spy(TelepatLogger.prototype, 'info');
			let client;

			try {
				client = new EsAdapter(esConfig);
			} catch (e) {
				expect(e).to.be.undefined; // disable-eslint-rule no-unused-expressions
			}
			expect(client.config.host).to.be.equal(esConfig.host);
			expect(client.config.hosts).to.be.undefined;

			client.onReady(() => {
				infoLogSpy.restore();
				sinon.assert.calledOnce(infoLogSpy);
				sinon.assert.calledWith(infoLogSpy, 'Connected to ElasticSearch MainDatabase');

				done();
			});
		});

		it('Shouldn\'t connect to a server because host timed out', done => {
			const esConfig = clone(common.config.ElasticSearch1);

			esConfig.host = '127.0.0.2:9200';
			esConfig.log = false;
			const infoLogSpy = sinon.spy(TelepatLogger.prototype, 'info');
			const errorLogSpy = sinon.spy(TelepatLogger.prototype, 'error');
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
			const infoLogSpy = sinon.spy(TelepatLogger.prototype, 'info');
			let client;

			try {
				client = new EsAdapter(esConfig);
			} catch (e) {
				expect(e).to.be.undefined;
			}

			expect(client.config.hosts).to.deep.equal(esConfig.hosts);
			expect(client.config.host).to.be.undefined;

			client.onReady(() => {
				infoLogSpy.restore();

				sinon.assert.calledWith(infoLogSpy, 'Connected to ElasticSearch MainDatabase');

				done();
			});
		});
	});
};
