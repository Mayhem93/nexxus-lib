import MainDatabase = require('../mainDatabase');
import {NexxusPromise} from '../../../global';
import NexxusError = require('../../NexxusError');
import {Client, ConfigOptions} from 'elasticsearch'

declare class ElasticSearchDB extends MainDatabase.Adapter {
	private connection: Client

	constructor(config: object | ConfigOptions)

	getObjects(applicationId: string, ids: Array<string>): NexxusPromise<MainDatabase.GetObjectsResultInterface>;

	searchObjects(applicationId: string, options: MainDatabase.DatabaseSearchOptions): NexxusPromise<MainDatabase.SearchObjectsResultInterface>;

	countObjects(applicationId: string, options: MainDatabase.DatabaseCountOptions): NexxusPromise<MainDatabase.CountObjectsResultInterface>;

	createObjects(applicationId: string, objects: Array<object>): NexxusPromise<MainDatabase.CreateObjectsResultInterface>;

	updateObjects(applicationId: string, patches: Array<object>): NexxusPromise<MainDatabase.UpdateObjectsResultsInterface>;

	deleteObjects(applicationId: string, objects: MainDatabase.DatabaseDeleteObjectsInput): NexxusPromise<MainDatabase.DeleteObjectsResultInterface>;
}

export = ElasticSearchDB
