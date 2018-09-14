import {EventEmitter} from 'events';
import {FilterBuilder} from '../../utils/filterbuilder';
import NexxusError = require('../NexxusError');
import {NexxusPromise} from '../../global';

declare namespace DBAdapter {
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

	interface DatabaseDeleteObjectsInputKeyValue {
		id: string
		applicationId: string
		type: string
	}

	interface GetObjectsResultInterface {
		errors: Array<NexxusError>
		results: Array<object>
		versions?: Map<string, Number>
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

		abstract getObjects(ids: Array<string>): NexxusPromise<GetObjectsResultInterface>;

		abstract searchObjects(options: DatabaseSearchOptions): NexxusPromise<SearchObjectsResultInterface>;

		abstract countObjects(options: DatabaseCountOptions): NexxusPromise<CountObjectsResultInterface>;

		abstract createObjects(objects: Array<object>): NexxusPromise<CreateObjectsResultInterface>;

		abstract updateObjects(patches: Array<object>): NexxusPromise<UpdateObjectsResultsInterface>;

		abstract deleteObjects(objects: Map<string, DatabaseDeleteObjectsInputKeyValue>): NexxusPromise<DeleteObjectsResultInterface>;
	}
}

export = DBAdapter
