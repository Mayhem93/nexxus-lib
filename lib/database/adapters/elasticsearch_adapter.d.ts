import DBAdapter = require('../mainDatabase');
import {NexxusPromise} from '../../../global';
import NexxusError = require('../../NexxusError');
import {Client, ConfigOptions} from 'elasticsearch'

declare class ElasticSearchDB extends DBAdapter.Adapter {
	private connection: Client

	constructor(config: object | ConfigOptions)

	getObjects(applicationId: string, ids: Array<string>): NexxusPromise<DBAdapter.GetObjectsResultInterface>;

	searchObjects(applicationId: string, options: DBAdapter.DatabaseSearchOptions): NexxusPromise<DBAdapter.SearchObjectsResultInterface>;

	countObjects(applicationId: string, options: DBAdapter.DatabaseCountOptions): NexxusPromise<DBAdapter.CountObjectsResultInterface>;

	createObjects(applicationId: string, objects: Array<object>): NexxusPromise<DBAdapter.CreateObjectsResultInterface>;

	updateObjects(applicationId: string, patches: Array<object>): NexxusPromise<DBAdapter.UpdateObjectsResultsInterface>;

	deleteObjects(applicationId: string, objects: DBAdapter.DatabaseDeleteObjectsInput): NexxusPromise<DBAdapter.DeleteObjectsResultInterface>;
}

export = ElasticSearchDB
