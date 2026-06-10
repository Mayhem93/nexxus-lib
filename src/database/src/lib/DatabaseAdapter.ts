import {
  NexxusBaseLogger,
  INexxusBaseServices,
  NexxusBaseService,
  NexxusConfig,
  NexxusBaseModel,
  NexxusApplication,
  NexxusUser,
  NexxusAppModel,
  NexxusModelTypeName,
  AnyNexxusModel,
  NexxusJsonPatch,
  NexxusFilterQuery,
  AnyNexxusModelData
} from '@mayhem93/nexxus-core-lib';

export type NexxusDatabaseAdapterEvents = {
  connect: [];
  disconnect: [];
  error: [Error];
}

export type NexxusDatabaseSortOrder = 'asc' | 'desc';

export interface NexxusDatabaseSortOptions {
  field: string;
  order: NexxusDatabaseSortOrder;
}

export interface NexxusDbSearchOptions<T extends NexxusModelTypeName | string = string> {
  type: T;
  id?: string;
  appId?: string;
  filter?: NexxusFilterQuery;
  limit?: number;
  offset?: number;
  sort?: NexxusDatabaseSortOptions;
  databaseSpecific?: Record<string, any>;
}

export interface NexxusDbGetOptions<T extends NexxusModelTypeName = string> {
  ids: Array<string>;
  type: T;
  appId?: string;
}

export interface NexxusDbUpdateOptions {
  returnFields?: Set<string>;
}

export abstract class NexxusDatabaseAdapter<T extends NexxusConfig, Ev extends NexxusDatabaseAdapterEvents>
  extends NexxusBaseService<T, Ev extends NexxusDatabaseAdapterEvents ? Ev : NexxusDatabaseAdapterEvents> {

  protected static configRootKey: string = "database";
  public static logger: NexxusBaseLogger<any>;

  constructor(services: INexxusBaseServices) {
    super(services.configManager.getConfig('database') as T);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new Error("Logger service is not properly initialized in Database");
    }

    NexxusDatabaseAdapter.logger = services.logger;
  }

  protected static loggerLabel : Readonly<string> = "NxxDatabase";

  abstract connect(): Promise<void>;
  abstract reConnect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  abstract createItems(collection: Array<AnyNexxusModel>): Promise<void>;
  // abstract getItems(options: NexxusDbGetOptions): Promise<Array<NexxusBaseModel | null>>;
  abstract getItems(options: NexxusDbGetOptions<'application'>): Promise<Array<NexxusApplication | null>>;
  abstract getItems(options: NexxusDbGetOptions<'user'>): Promise<Array<NexxusUser | null>>;
  abstract getItems(options: NexxusDbGetOptions<string>): Promise<Array<NexxusAppModel | null>>;
  abstract searchItems(options: NexxusDbSearchOptions<'application'>): Promise<NexxusApplication[]>;
  abstract searchItems(options: NexxusDbSearchOptions<'user'>): Promise<NexxusUser[]>;
  abstract searchItems(options: NexxusDbSearchOptions<string>): Promise<NexxusAppModel[]>;
  abstract updateItems(collection: Array<NexxusJsonPatch>, options?: NexxusDbUpdateOptions): Promise<Array<Partial<AnyNexxusModelData>> | void>;
  abstract deleteItems(collection: Array<NexxusBaseModel>): Promise<void>;

  protected abstract buildQuery(options: NexxusDbSearchOptions<string>): string | object;
}
