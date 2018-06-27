const chai = require('chai');
const expect = chai.expect;
const NexxusLib = require('../index');
const NexxusError = require('../lib/NexxusError');
const promisify = require('util').promisify;
const fs = require('fs');
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

const CONFIG_FILE_SPEC = './test/test-spec-file.json';
const CONFIG_FILE = './test/test-config-file.json';

chai.should();
chai.use(require('chai-things'));

describe('index.init', () => {
	before(async () => {
		let config = JSON.parse(await readFile(CONFIG_FILE));
		let configSpec = JSON.parse(await readFile(CONFIG_FILE_SPEC));

		config.main_database = 'ElasticSearch';
		configSpec.root[0].enum = ['ElasticSearch'];

		await writeFile(CONFIG_FILE, JSON.stringify(config, null, 4));
		await writeFile(CONFIG_FILE_SPEC, JSON.stringify(configSpec, null, 4));
	});

	it('Sould fail because mainDatabase was not found due to badly configured config file and spec file', async () => {
		try {
			await NexxusLib.init({
				configFileSpec: CONFIG_FILE_SPEC,
				configFile: CONFIG_FILE,
				nodeIndex: 0,
				serviceType: 'api'
			});

			return new Error('Should throw error');
		} catch (e) {
			expect(e).to.be.instanceOf(NexxusError, e.stack);
			expect(e.code).to.be.eq('ServerFailure', e.stack);
		}

		return true;
	});

	it('Should succcessfuly connect to services', async function (done) {
		this.timeout(30000);

		let config = JSON.parse(await readFile(CONFIG_FILE));
		let configSpec = JSON.parse(await readFile(CONFIG_FILE_SPEC));

		config.main_database = 'elasticsearch';
		configSpec.root[0].enum = ['elasticsearch'];

		await writeFile(CONFIG_FILE, JSON.stringify(config, null, 4));
		await writeFile(CONFIG_FILE_SPEC, JSON.stringify(configSpec, null, 4));

		await NexxusLib.init({
			configFileSpec: CONFIG_FILE_SPEC,
			configFile: CONFIG_FILE,
			nodeIndex: 0,
			serviceType: 'api'
		});

		done();
	});
});
