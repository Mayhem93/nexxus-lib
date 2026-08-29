import {
  NexxusBaseLogger,
  INexxusBaseServices,
  NexxusBaseService,
  NexxusConfig,
  NexxusBaseModel,
  NexxusApplication,
  NexxusUser,
  NexxusSetting,
  NexxusAclRole,
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

export type NexxusDbCountOptions<T extends NexxusModelTypeName | string = string> = Omit<NexxusDbSearchOptions<T>, 'id' | 'limit' | 'offset' | 'sort'>;

export interface NexxusDbGetOptions<T extends NexxusModelTypeName = string> {
  ids: Array<string>;
  type: T;
  appId?: string;
}

export interface NexxusDbUpdateOptions {
  returnFields?: Set<string>;
}

export type NexxusDatabaseAdapterStats = {};

export abstract class NexxusDatabaseAdapter<
  T extends NexxusConfig,
  Ev extends NexxusDatabaseAdapterEvents,
  TStats extends NexxusDatabaseAdapterStats = {}
>
  extends NexxusBaseService<T, Ev extends NexxusDatabaseAdapterEvents ? Ev : NexxusDatabaseAdapterEvents, TStats> {

  protected static configRootKey: string = 'database';
  public static logger: NexxusBaseLogger<any>;

  constructor(services: INexxusBaseServices) {
    super(services.configManager.getConfig('database') as T);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new Error('Logger service is not properly initialized in Database');
    }

    NexxusDatabaseAdapter.logger = services.logger;
  }

  protected static loggerLabel : Readonly<string> = 'NxxDatabase';

  public abstract connect(): Promise<void>;
  public abstract disconnect(): Promise<void>;

  /**
   * Returns a bootstrapper wired to this adapter's already-connected
   * client. Called by the Nexxus CLI at deployment provisioning time and
   * by the Hub API on application-lifecycle events (v1: creation only).
   * See `NexxusDatabaseBootstrapper` for the full contract.
   */
  public abstract getBootstrapper(): NexxusDatabaseBootstrapper;

  public abstract createItems(collection: Array<AnyNexxusModel>): Promise<void>;
  // public abstract getItems(options: NexxusDbGetOptions): Promise<Array<NexxusBaseModel | null>>;
  public abstract getItems(options: NexxusDbGetOptions<'application'>): Promise<Array<NexxusApplication | null>>;
  public abstract getItems(options: NexxusDbGetOptions<'user'>): Promise<Array<NexxusUser | null>>;
  public abstract getItems(options: NexxusDbGetOptions<'setting'>): Promise<Array<NexxusSetting | null>>;
  public abstract getItems(options: NexxusDbGetOptions<'acl'>): Promise<Array<NexxusAclRole | null>>;
  public abstract getItems(options: NexxusDbGetOptions<string>): Promise<Array<NexxusAppModel | null>>;
  public abstract searchItems(options: NexxusDbSearchOptions<'application'>): Promise<NexxusApplication[]>;
  public abstract searchItems(options: NexxusDbSearchOptions<'user'>): Promise<NexxusUser[]>;
  public abstract searchItems(options: NexxusDbSearchOptions<'setting'>): Promise<NexxusSetting[]>;
  public abstract searchItems(options: NexxusDbSearchOptions<'acl'>): Promise<NexxusAclRole[]>;
  public abstract searchItems(options: NexxusDbSearchOptions<string>): Promise<NexxusAppModel[]>;
  public abstract updateItems(collection: Array<NexxusJsonPatch>, options?: NexxusDbUpdateOptions): Promise<Array<Partial<AnyNexxusModelData>> | void>;
  public abstract deleteItems(collection: Array<NexxusBaseModel>): Promise<void>;
  public abstract countItems(options: NexxusDbCountOptions): Promise<number>;

  protected abstract buildQuery(options: NexxusDbSearchOptions<string>): string | object;
}

/**
 * Deployment-time hook surface for a database adapter. Each concrete adapter
 * ships its own subclass with the client passed in at construction; callers
 * (the Nexxus CLI at provisioning time, the Hub API when an application is
 * created) obtain an instance via the adapter's `getBootstrapper()` method so
 * they never touch the adapter's underlying driver directly.
 *
 * **Migration is explicitly out of scope for this class.** The bootstrapper
 * sets up infrastructure the runtime pipeline expects to exist; it does not
 * handle framework-version upgrades, cross-version schema evolution, or data
 * rewrites. Those belong to a separate migration surface (not yet designed)
 * and should not be bolted on here.
 */
export abstract class NexxusDatabaseBootstrapper {
  /**
   * Idempotent one-shot deployment setup. Creates the base infrastructure
   * the runtime pipeline expects to exist — per-adapter: base indices, base
   * tables, base collections, etc. Called by the CLI at deployment
   * provisioning time.
   *
   * **Must be idempotent.** Safe to re-run: skip anything already present
   * rather than error. Operators running `nexxus bootstrap` twice, or Hub
   * replaying a partial setup after a restart, must be a no-op the second
   * time.
   */
  public abstract bootstrapDeployment(): Promise<void>;

  /**
   * Called when a new Nexxus application is created (via Hub or CLI). The
   * adapter provisions whatever per-application storage its runtime needs —
   * for ES, per-app-per-model indices with explicit mappings; for a
   * relational store, per-app tables; for a document store, a per-app
   * collection; etc.
   *
   * **Must be idempotent.** A re-create for an already-known app id should
   * skip any per-app storage that already exists rather than fail. This
   * lets Hub safely replay an `app_created` event after a restart.
   */
  public abstract onApplicationCreated(app: NexxusApplication): Promise<void>;
}
