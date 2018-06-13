import {MainDatabase} from './mainDatabase';
import {RedisClient} from 'redis';

declare const redisClient: RedisClient;

export declare class Datasource {
	readonly dataStorage: MainDatabase
	readonly cacheStorage: RedisClient

	constructor();

	setMainDatabase(database: MainDatabase): void;

	setCacheStorage(database: RedisClient): void;
}
