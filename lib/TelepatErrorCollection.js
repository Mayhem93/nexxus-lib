const NexxusError = require('./NexxusError');

class NexxusErrorCollection extends NexxusError {
	constructor (errorCollection) {
		super('ErrorCollection', errorCollection.reduce((initial, err) => {
			return `\t\t${initial}${err.message}\n`;
		}, ''));
	}
}

module.exports = NexxusErrorCollection;
