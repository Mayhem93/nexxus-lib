const common = require('../../common');
const chai = require('chai');
const expect = chai.expect;
const clone = require('clone');
const ConfigurationManager = require('../lib/ConfigurationManager');

chai.should();
chai.use(require('chai-things'));

const sinon = require('sinon');

module.exports = () => {
	describe('index.init', () => {
		it('Sould fail because ConfigurationManager failed to load', done => {
			const loadFunctionStub = sinon.stub(ConfigurationManager.prototype, 'load', callback => callback(new Error('')));
		});
	});
};
