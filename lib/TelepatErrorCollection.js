const TelepatError = require('./TelepatError');

class TelepatErrorCollection extends TelepatError {
	constructor (errorCollection) {
		super('ErrorCollection', errorCollection.reduce((initial, err) => {
			return `\t\t${initial}${err.message}\n`;
		}, ''));
	}
}

module.exports = TelepatErrorCollection;
