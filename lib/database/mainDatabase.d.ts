import {EventEmitter} from 'events';
import {FilterBuilder} from '../../utils/filterbuilder';
import {TelepatError} from '../TelepatError';
import {TelepatPromise} from '../../global';

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
	scanFunction?: (objects: Array<object>) => TelepatPromise<null, TelepatError>
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

export abstract class MainDatabase extends EventEmitter {
	constructor(connection: any);

	abstract getObjects(ids: Array<string>): TelepatPromise<Array<Object>, Array<TelepatError>>;

	abstract searchObjects(options: DatabaseSearchOptions): TelepatPromise<Array<Object>, TelepatError>;

	abstract countObjects(options: DatabaseCountOptions): TelepatPromise<object, TelepatError>;

	abstract createObjects(objects: Array<object>): TelepatPromise< Array<object>, Array<TelepatError> >;

	abstract  deleteObjects(objects: DatabaseDeleteObjectsInput): TelepatPromise< Array<object>, Array<TelepatError> >;
}
