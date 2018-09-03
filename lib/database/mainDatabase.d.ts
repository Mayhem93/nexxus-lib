import {EventEmitter} from 'events';
import {FilterBuilder} from '../../utils/filterbuilder';
import NexxusError = require('../NexxusError');
import {NexxusPromise} from '../../global';

declare namespace MainDatabase {
	const enum SortType {
		'geo' = 'geo'
	}

	const enum SortOrder {
		'asc' = 'asc',
		'desc' = 'desc'
	}

	interface DatabaseGeoSort {
		long: Number,
		lat: Number
	}

	interface DatabaseSortOption {
		[key: string]: {
			type?: SortType,
			order?: SortOrder,
			poi?: DatabaseGeoSort
		}
	}

	interface DatabaseSearchOptions {
		modelName: string,
		filters?: FilterBuilder,
		sort?: DatabaseSortOption,
		offset?: Number,
		limit?: Number,
		fields?: Array<string>,
		scanFunction?: (objects: Array<object>) => NexxusPromise<null>
	}

	const enum AggregationType {
		'avg' = 'avg',
		'min' = 'min',
		'max' = 'max'
	}

	type AggregationOption = { [key in AggregationType]: Object }

	interface DatabaseCountOptions {
		modelName: string,
		filters?: FilterBuilder,
		aggregation?: AggregationOption
	}

	interface DatabaseDeleteObjectsInput {
		[id: string]: string
	}

	interface GetObjectsResultInterface {
		errors: Array<NexxusError>
		results: Array<object>
		versions?: Array<Number>
	}

	interface SearchObjectsResultInterface {
		results: Array<object>
	}

	interface CountObjectsResultInterface {
		count: Number
	}

	interface CreateObjectsResultInterface {
		errors: Array<NexxusError>
	}

	interface UpdateObjectsResultsInterface {
		errors: Array<NexxusError>
		results: Array<object>
	}

	interface DeleteObjectsResultInterface {
		errors: Array<NexxusError>
		results: Array<string>
	}
	abstract class Adapter extends EventEmitter {
		constructor(connection: any);

		abstract getObjects(applicationId: string, ids: Array<string>): NexxusPromise<GetObjectsResultInterface>;

		abstract searchObjects(applicationId: string, options: DatabaseSearchOptions): NexxusPromise<SearchObjectsResultInterface>;

		abstract countObjects(applicationId: string, options: DatabaseCountOptions): NexxusPromise<CountObjectsResultInterface>;

		abstract createObjects(applicationId: string, objects: Array<object>): NexxusPromise<CreateObjectsResultInterface>;

		abstract updateObjects(applicationId: string, patches: Array<object>): NexxusPromise<UpdateObjectsResultsInterface>;

		abstract deleteObjects(applicationId: string, objects: DatabaseDeleteObjectsInput): NexxusPromise<DeleteObjectsResultInterface>;
	}
}

export = MainDatabase
