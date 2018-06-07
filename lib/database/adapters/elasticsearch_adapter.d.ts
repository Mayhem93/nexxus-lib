import {MainDatabase, DatabaseSearchOptions, DatabaseCountOptions, DatabaseDeleteObjectsInput} from '../mainDatabase';
import {TelepatPromise} from '../../../global';
import TelepatError = require('../../TelepatError');

export class ElasticSearchDB extends MainDatabase {
	constructor(config: object)

	getObjects(ids: Array<string>): TelepatPromise<Array<Object>, Array<TelepatError>>;

	searchObjects(options: DatabaseSearchOptions): TelepatPromise<Array<Object>, TelepatError>;

	countObjects(options: DatabaseCountOptions): TelepatPromise<object, TelepatError>;

	createObjects(objects: Array<object>): TelepatPromise<Array<object>, Array<TelepatError>>;

	deleteObjects(objects: DatabaseDeleteObjectsInput): TelepatPromise<Array<object>, Array<TelepatError>>;
}
