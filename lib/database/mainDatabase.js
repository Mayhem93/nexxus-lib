const EventEmitter = require('events');

class MainDatabaseAdapter extends EventEmitter {
	constructor (connection) {
		super();
		this.connection = connection;
	}

	getObjects (ids) {
		throw new Error('Database adapter "getObjects" not implemented');
	}

	searchObjects (options) {
		throw new Error('Database adapter "searchObjects" not implemented');
	}

	countObjects (options) {
		throw new Error('Database adapter "countObjects" not implemented');
	}

	createObjects (objects) {
		throw new Error('Database adapter "createObjects" not implemented');
	}

	updateObjects (patches) {
		throw new Error('Database adapter "updateObjects" not implemented');
	}

	deleteObjects (ids) {
		throw new Error('Database adapter "deleteObjects" not implemented');
	}
}

module.exports = MainDatabaseAdapter;
