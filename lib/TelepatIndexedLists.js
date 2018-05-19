const Services = require('./Services');
const TelepatError = require('./TelepatError');
const utils = require('../utils/utils');
const async = require('async');

class TelepatIndexedList {
	/**
	 * @callback appendCb
	 * @param {Error|null} [err]
	 */

	/**
	 * @callback removeCb
	 * @param {Error|null} [err]
	 * @param {Boolean} [removed]
	 */

	/**
	 * @callback getCb
	 * @param {Error|null} [err]
	 * @param {Object[]} [results]
	 */

	/**
	 *
	 * @param {string} listName Name of the list
	 * @param {string} indexedProperty The property that's being indexed by
	 * @param {Object} object The key of this object is the member that will be inserted with its value
	 * @param {appendCb} callback
	 */
	static append (listName, indexedProperty, object, callback) {
		let commandArgs = [`blg:til:${listName}:${indexedProperty}:${object[indexedProperty]}`];

		for (let prop in object) {
			if (typeof object[prop] !== 'object') {
				commandArgs.push(prop, object[prop]);
			}
		}

		Services.redisCacheClient.hmset(commandArgs, callback);
	}

	/**
	 *
	 * @param {string} listName Name of the list
	 * @param {string} indexedProperty The property that's being indexed by
	 * @param {string[]} members Array of memembers to check for
	 * @param {getCb} callback
	 */
	static get (listName, indexedProperty, members, callback) {
		let baseKey = `blg:til:${listName}:${indexedProperty}`;
		let tranzaction = Services.redisCacheClient.multi();

		members.forEach(member => {
			tranzaction.hgetall([`${baseKey}:${member}`]);
		});

		tranzaction.exec((err, replies) => {
			if (err) {
				return callback(err);
			}
			let memebershipResults = {};

			return async.forEachOf(replies, (result, index, c) => {
				memebershipResults[members[index]] = result || false;
				c();
			}, () => {
				callback(null, memebershipResults);
			});
		});
	}

	/**
	 *
	 * @param {string} listName Name of the list to remove
	 * @param {removeCb} callback
	 */
	static removeList (listName, callback) {
		let keyPattern = `blg:til:${listName}:*`;

		utils.scanRedisKeysPattern(keyPattern, Services.redisCacheClient, (err, results) => {
			if (err) return callback(err);

			if (!results.length) {
				return callback(new TelepatError(TelepatError.errors.TilNotFound, [listName]));
			}

			Services.redisCacheClient.del(results, (err, removed) => {
				if (err) {
					return callback(err);
				}

				return callback(null, !!removed);
			});
		});
	}

	/**
	 *
	 * @param {string} listName Name of the list
	 * @param {string} indexedProperty The property that's being indexed by
	 * @param {string[]} members Array of memembers to remove
	 * @param {removeCb} callback
	 */
	static removeMember (listName, indexedProperty, members, callback) {
		let baseKey = `blg:til:${listName}:${indexedProperty}`;
		let existingMembers = {}; // to avoid duplicate members
		let delArguments = [];

		members.forEach(member => {
			if (!existingMembers[member]) {
				delArguments.push([`${baseKey}:${member}`]);
				existingMembers[member] = true;
			}
		});

		Services.redisCacheClient.del(delArguments, callback);
	}
}

module.exports = TelepatIndexedList;
