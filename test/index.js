const common = require('./common');
const chai = require('chai');
const expect = chai.expect;
const assert = chai.assert;
const clone = require('clone');
const TelepatLib = require('../index');
const TelepatError = require('../lib/TelepatError');
const ConfigurationManager = require('../lib/ConfigurationManager');

chai.should();
chai.use(require('chai-things'));

const sinon = require('sinon');

describe('index.init', () => {
	it('Sould fail because ConfigurationManager failed to load', async () => {
		const loadFunctionStub = sinon.stub(ConfigurationManager.prototype, 'load').throws(new TelepatError(TelepatError.errors.ServerConfigurationFailure));

		try {
			await TelepatLib.init({
				configFileSpec: '',
				configFile: '',
				name: 'telepat-api'
			});

			return new Error('Should throw error');
		} catch (e) {
			expect(e).to.be.instanceOf(TelepatError);
			expect(e.code).to.be.eq(TelepatError.errors.ServerConfigurationFailure);
		}

		loadFunctionStub.restore();

		return true;
	});
});
