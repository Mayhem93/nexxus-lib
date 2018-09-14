import DBAdapter = require('../mainDatabase');
import {NexxusPromise} from '../../../global';
import NexxusError = require('../../NexxusError');
import NexxusPatch = require('../../Patch');
import {Client, ConfigOptions} from 'elasticsearch'

declare class ElasticSearchDB extends DBAdapter.Adapter {
	private connection: Client

	constructor(config: object | ConfigOptions)

	getObjects(ids: Array<string>): NexxusPromise<DBAdapter.GetObjectsResultInterface>;

	searchObjects(options: DBAdapter.DatabaseSearchOptions): NexxusPromise<DBAdapter.SearchObjectsResultInterface>;

	countObjects(options: DBAdapter.DatabaseCountOptions): NexxusPromise<DBAdapter.CountObjectsResultInterface>;

	createObjects(objects: Array<object>): NexxusPromise<DBAdapter.CreateObjectsResultInterface>;

	updateObjects(patches: Array<NexxusPatch>): NexxusPromise<DBAdapter.UpdateObjectsResultsInterface>;

	deleteObjects(objects: Map<string, DBAdapter.DatabaseDeleteObjectsInputKeyValue>): NexxusPromise<DBAdapter.DeleteObjectsResultInterface>;
}

export = ElasticSearchDB
