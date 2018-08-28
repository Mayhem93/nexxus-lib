const async = require('async');
const FilterBuilder = require('../utils/filterbuilder').FilterBuilder;
const guid = require('uuid');
const NexxusError = require('./NexxusError');
const NexxusErrorCollection = require('./NexxusErrorCollection');
const Services = require('./Services');
const BaseModel = require('./BaseModel');

class User extends BaseModel {
	constructor (props) {
		props.type = 'user';
		const proxiedParent = super(props, ['application_id']);

		return proxiedParent;
	}

	static async get (user, appId) {
		if (user.id) {
			const {errors, results} = await Services.datasource.dataStorage.getObjects([user.id]);

			if (errors[0]) {
				throw errors[0];
			}

			return new User(results[0]);
		} else if (user.username) {
			let filters = (new FilterBuilder('and')).addFilter('is', {'application_id': appId}).addFilter('is', {'username': user.username});

			const {errors, results} = await Services.datasource.dataStorage.searchObjects({modelName: 'user', filters});

			if (errors[0]) {
				throw errors[0];
			}

			if (!results.length) {
				throw new NexxusError('UserNotFound');
			}

			return new User(results[0]);
		}

		return null;
	}

	static async create (props) {
		props.id = props.id || guid.v4();
		let newUser = new User(props);

		try {
			await User.get({username: newUser.username}, newUser.application_id);
		} catch (err) {
			if (err && err.code === 'UserNotFound') {
				const {errors} = Services.datasource.dataStorage.createObjects([newUser.properties]);

				if (errors[0]) {
					throw errors[0];
				}

				return newUser;
			} else if (!err) {
				throw new NexxusError(NexxusError.errors.UserAlreadyExists);
			} else {
				throw err;
			}
		}

		return null;
	}

	static async delete (user) {
		let id = user.id;

		// await User.get({ id }, appId);
		const {errors} = await Services.datasource.dataStorage.deleteObjects({[ id ]: 'user'});

		if (errors[0]) {
			throw errors[0];
		}

		let deleteUserObjects = obj => {
			let deleteObjects = {};

			async.each(obj, (o, c) => {
				deleteObjects[o.id] = o.type;
				c();
			}, async () => {
				const {errors} = await Services.datasource.dataStorage.deleteObjects(deleteObjects);

				Services.logger.warning(new NexxusErrorCollection(errors));
			});
		};

		let filter = (new FilterBuilder()).addFilter('is', { user_id: id });

		await Services.datasource.dataStorage.searchObjects({ filters: filter, fields: ['id', 'type'], scanFunction: deleteUserObjects });

		/* async.series([
			callback1 => {
				async.each(user.devices, (deviceId, c1) => {
					Services.redisClient.get(`blg:devices:${deviceId}`, (err, response) => {
						if (err) {
							return c1(err);
						}

						if (response) {
							let device = JSON.parse(response);

							if (device.subscriptions) {
								let transaction = Services.redisClient.multi();

								device.subscriptions.each(sub => {
									transaction.srem([sub, deviceId]);
								});

								transaction.del(`blg:devices:${deviceId}`);

								return transaction.exec(err => {
									if (err) {
										Services.logger.warning(`Failed removing device from subscriptions: ${err.message}`);
									}
								});
							}
						}

						return c1();
					});
				});
				callback1();
			},
			callback1 => {

			}
		], callback); */
	}

	static async update (patches) {
		const {errors} = await Services.datasource.dataStorage.updateObjects(patches);

		if (errors[0]) {
			throw errors[0];
		}
	}

	static getAll (appId, offset, limit) {
		let filters = (new FilterBuilder()).addFilter('is', {application_id: appId});

		return Services.datasource.dataStorage.searchObjects({modelName: 'user', filters, offset, limit});
	}
}

module.exports = User;
