import {MainDatabase} from './mainDatabase';

export class Datasource {
	dataStorage: MainDatabase
	cacheStorage: any

	constructor();

	setMainDatabase(database: MainDatabase): void;

	setCacheStorage(database: any): void;
}
