import DBAdapter = require('./mainDatabase')
import {RedisClient} from 'redis'

declare const redisClient: RedisClient

declare class Datasource {
	readonly dataStorage: DBAdapter.Adapter
	readonly cacheStorage: RedisClient

	constructor()

	setMainDatabase(database: DBAdapter.Adapter): void

	setCacheStorage(database: RedisClient): void
}
