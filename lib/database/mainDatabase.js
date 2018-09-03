const EventEmitter = require('events');

class MainDatabaseAdapter extends EventEmitter {
	constructor (connection) {
		super();
		this.connection = connection;
	}

	getObjects (applicationId, ids) {
		throw new Error('Database adapter "getObjects" not implemented');
	}

	searchObjects (applicationId, options) {
		throw new Error('Database adapter "searchObjects" not implemented');
	}

	countObjects (applicationId, options) {
		throw new Error('Database adapter "countObjects" not implemented');
	}

	createObjects (applicationId, objects) {
		throw new Error('Database adapter "createObjects" not implemented');
	}

	updateObjects (applicationid, patches) {
		throw new Error('Database adapter "updateObjects" not implemented');
	}

	deleteObjects (applicationId, ids) {
		throw new Error('Database adapter "deleteObjects" not implemented');
	}
}

module.exports = MainDatabaseAdapter;
