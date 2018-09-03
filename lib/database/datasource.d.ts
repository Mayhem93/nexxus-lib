import {MainDatabaseAdapter} from './mainDatabase';
import {RedisClient} from 'redis';

declare const redisClient: RedisClient;

export declare class Datasource {
	readonly dataStorage: MainDatabaseAdapter
	readonly cacheStorage: RedisClient

	constructor();

	setMainDatabase(database: MainDatabaseAdapter): void;

	setCacheStorage(database: RedisClient): void;
}
