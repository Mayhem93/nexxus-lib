import { TelepatError, ERRORS } from './lib/TelepatError';

export class TelepatPromise<T, E> implements Promise<T> {
	then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: TelepatError | Array<TelepatError>) => TResult2 | PromiseLike<TResult2>) | undefined | null): Promise<TResult1 | TResult2>;
	catch<TResult = never>(onrejected?: ((reason: TelepatError | Array<TelepatError>) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult>;
}
