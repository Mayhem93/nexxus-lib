const EventEmitter = require('events');

class MainDatabaseAdapter extends EventEmitter {
	constructor (connection) {
		super();
		this.connection = connection;
	}

	getObjects (ids, callback) {
		throw new Error('Database adapter "getObjects" not implemented');
	}

	searchObjects (options, callback) {
		throw new Error('Database adapter "searchObjects" not implemented');
	}

	countObjects (options, callback) {
		throw new Error('Database adapter "countObjects" not implemented');
	}

	createObjects (objects, callback) {
		throw new Error('Database adapter "createObjects" not implemented');
	}

	deleteObjects (ids, callback) {
		throw new Error('Database adapter "deleteObjects" not implemented');
	}
}

module.exports = MainDatabaseAdapter;
