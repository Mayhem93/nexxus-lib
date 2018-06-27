import {
	MainDatabase,
	GetObjectsResultInterface,
	SearchObjectsResultInterface,
	CountObjectsResultInterface,
	CreateObjectsResultInterface,
	UpdateObjectsResultsInterface,
	DeleteObjectsResultInterface,
	DatabaseSearchOptions,
	DatabaseCountOptions,
	DatabaseDeleteObjectsInput
} from '../mainDatabase';
import {NexxusPromise} from '../../../global';
import NexxusError = require('../../NexxusError');

export class ElasticSearchDB extends MainDatabase {
	constructor(config: object)

	getObjects(ids: Array<string>): NexxusPromise<GetObjectsResultInterface>;

	searchObjects(options: DatabaseSearchOptions): NexxusPromise<SearchObjectsResultInterface>;

	countObjects(options: DatabaseCountOptions): NexxusPromise<CountObjectsResultInterface>;

	createObjects(objects: Array<object>): NexxusPromise<CreateObjectsResultInterface>;

	updateObjects(patches: Array<object>): NexxusPromise<UpdateObjectsResultsInterface>;

	deleteObjects(objects: DatabaseDeleteObjectsInput): NexxusPromise<DeleteObjectsResultInterface>;
}
