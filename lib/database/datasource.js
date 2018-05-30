const MainDatabase = require('./mainDatabase');
const TelepatError = require('../TelepatError');

class Datasource {
	constructor () {
		/**
		 * @type MainDatabaseAdapter
		 */
		this.dataStorage = null;
		this.cacheStorage = null;
	}

	/**
	 *
	 * @param {Main_Database_Adapter} database
	 */
	setMainDatabase (database) {
		if (!(database instanceof MainDatabase)) {
			throw new TelepatError(TelepatError.errors.ServerFailure, 'Invalid main database supplied');
		}

		this.dataStorage = database;
	}

	setCacheDatabase (database) {
		this.cacheStorage = database;
	}
}

module.exports = Datasource;
