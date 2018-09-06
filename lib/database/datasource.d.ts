import DBAdapter = require('./mainDatabase')
import {RedisClient} from 'redis'

declare const redisClient: RedisClient

declare interface DatasourceConstructor {
	readonly prototype: Datasource
	new(): Datasource
}

declare class Datasource {
	readonly dataStorage: DBAdapter.Adapter
	readonly cacheStorage: RedisClient

	setMainDatabase(database: DBAdapter.Adapter): void

	setCacheStorage(database: RedisClient): void
}

export = DatasourceConstructor
