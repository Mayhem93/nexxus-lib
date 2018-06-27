import NexxusError = require('./lib/NexxusError')

export class NexxusPromise<T> implements Promise<T> {
	then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: NexxusError | Array<NexxusError>) => TResult2 | PromiseLike<TResult2>) | undefined | null): Promise<TResult1 | TResult2>;
	catch<TResult = never>(onrejected?: ((reason: NexxusError | Array<NexxusError>) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult>;
}

export declare interface ServiceOptions {
	serviceType: string,
	nodeIndex: number,
	configFile: string,
	configFileSpec: string
}
