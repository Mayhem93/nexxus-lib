const MainDatabase = require('./mainDatabase');
const NexxusError = require('../NexxusError');

class Datasource {
	constructor () {
		this.dataStorage = null;
		this.cacheStorage = null;
	}

	setMainDatabase (database) {
		if (!(database instanceof MainDatabase)) {
			throw new NexxusError(NexxusError.errors.ServerFailure, 'Invalid main database supplied');
		}

		this.dataStorage = database;
	}

	setCacheDatabase (database) {
		this.cacheStorage = database;
	}
}

module.exports = Datasource;
