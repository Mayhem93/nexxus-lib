import { vi } from 'vitest';

/**
 * Shared fake for `@elastic/elasticsearch`'s `Client`. Registered via a PARTIAL
 * vi.mock in index.test.ts that keeps the real `errors.*` classes (so the
 * adapter's `instanceof ConnectionError` / `ResponseError` checks work against
 * errors we throw here). Tests program `state.*` return values / impls and read
 * back `state.calls.*`.
 */
export const state: {
  ctorOptions: any;
  ping: (() => any) | null;
  bulkResult: any;
  searchResult: any;
  mget: (() => any) | null;
  countResult: any;
  health: any;
  catIndices: any[];
  existsResult: boolean;
  calls: {
    bulk: any[];
    search: any[];
    mget: any[];
    count: any[];
    refresh: any[];
    indicesExists: any[];
    indicesCreate: any[];
    close: number;
  };
} = {
  ctorOptions: null,
  ping: null,
  bulkResult: { errors: false, items: [] },
  searchResult: { hits: { hits: [] } },
  mget: null,
  countResult: { count: 0 },
  health: { cluster_name: 'nxx', status: 'green', number_of_nodes: 1 },
  catIndices: [],
  existsResult: false,
  calls: { bulk: [], search: [], mget: [], count: [], refresh: [], indicesExists: [], indicesCreate: [], close: 0 },
};

export function resetEs(): void {
  Object.assign(state, {
    ctorOptions: null,
    ping: null,
    bulkResult: { errors: false, items: [] },
    searchResult: { hits: { hits: [] } },
    mget: null,
    countResult: { count: 0 },
    health: { cluster_name: 'nxx', status: 'green', number_of_nodes: 1 },
    catIndices: [],
    existsResult: false,
    calls: { bulk: [], search: [], mget: [], count: [], refresh: [], indicesExists: [], indicesCreate: [], close: 0 },
  });
}

export class FakeEsClient {
  public cluster = { health: vi.fn(async () => state.health) };
  public cat = { indices: vi.fn(async (_opts: any) => state.catIndices) };
  public indices = {
    exists: vi.fn(async (opts: any) => { state.calls.indicesExists.push(opts); return state.existsResult; }),
    create: vi.fn(async (opts: any) => { state.calls.indicesCreate.push(opts); return { acknowledged: true }; }),
    refresh: vi.fn(async (opts: any) => { state.calls.refresh.push(opts); return { _shards: {} }; }),
  };

  constructor(options: any) {
    state.ctorOptions = options;
  }

  async ping(_opts?: any, _reqOpts?: any): Promise<any> {
    return state.ping ? state.ping() : true;
  }

  async close(): Promise<void> {
    state.calls.close += 1;
  }

  async bulk(req: any): Promise<any> {
    state.calls.bulk.push(req);

    return state.bulkResult;
  }

  async search(req: any): Promise<any> {
    state.calls.search.push(req);

    return state.searchResult;
  }

  async mget(req: any): Promise<any> {
    state.calls.mget.push(req);

    return state.mget ? state.mget() : { docs: [] };
  }

  async count(req: any): Promise<any> {
    state.calls.count.push(req);

    return state.countResult;
  }
}
