import DBAdapter = require('../mainDatabase');
import {NexxusPromise} from '../../../global';
import NexxusError = require('../../NexxusError');
import NexxusPatch = require('../../Patch');
import {Client, ConfigOptions} from 'elasticsearch'

interface ElasticSearchDBConstructor extends DBAdapter.Adapter {
	readonly prototype: ElasticSearchDB
	new(config: object | ConfigOptions): ElasticSearchDB

	connection: Client

	getObjects(ids: Array<string>): NexxusPromise<DBAdapter.GetObjectsResultInterface>;

	searchObjects(options: DBAdapter.DatabaseSearchOptions): NexxusPromise<DBAdapter.SearchObjectsResultInterface>;

	countObjects(options: DBAdapter.DatabaseCountOptions): NexxusPromise<DBAdapter.CountObjectsResultInterface>;

	createObjects(objects: Array<object>): NexxusPromise<DBAdapter.CreateObjectsResultInterface>;

	updateObjects(patches: Array<NexxusPatch>): NexxusPromise<DBAdapter.UpdateObjectsResultsInterface>;

	deleteObjects(objects: Map<string, DBAdapter.DatabaseDeleteObjectsInputKeyValue>): NexxusPromise<DBAdapter.DeleteObjectsResultInterface>;
}

interface ElasticSearchDB extends DBAdapter.Adapter { }

declare const ElasticSearchDBConstructor : ElasticSearchDBConstructor & ElasticSearchDB

export = ElasticSearchDBConstructor
