import {EventEmitter} from 'events';
import {FilterBuilder} from '../../utils/filterbuilder';
import NexxusError = require('../NexxusError');
import {NexxusPromise} from '../../global';

declare const enum SortType {
	'geo' = 'geo'
}

declare const enum SortOrder {
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

declare const enum AggregationType {
	'avg' = 'avg',
	'min' = 'min',
	'max' = 'max'
}

type AggregationOption = {[key in AggregationType]: Object}

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

export abstract class MainDatabase extends EventEmitter {
	constructor(connection: any);

	abstract getObjects(ids: Array<string>): NexxusPromise<GetObjectsResultInterface>;

	abstract searchObjects(options: DatabaseSearchOptions): NexxusPromise<SearchObjectsResultInterface>;

	abstract countObjects(options: DatabaseCountOptions): NexxusPromise<CountObjectsResultInterface>;

	abstract createObjects(objects: Array<object>): NexxusPromise<CreateObjectsResultInterface>;

	abstract updateObjects(patches: Array<object>): NexxusPromise<UpdateObjectsResultsInterface>;

	abstract deleteObjects(objects: DatabaseDeleteObjectsInput): NexxusPromise<DeleteObjectsResultInterface>;
}
