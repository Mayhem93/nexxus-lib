import {
  NexxusDatabaseAdapter,
  NexxusDatabaseAdapterEvents,
  NexxusDatabaseAdapterStats,
  NexxusDbCountOptions,
  NexxusDbGetOptions,
  NexxusDbSearchOptions,
  NexxusDbUpdateOptions
} from './DatabaseAdapter';
import { NexxusElasticsearchDbBootstrapper } from './ElasticsearchDbBootstrapper';
import {
  NexxusConfig,
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusBaseModel,
  INexxusBaseServices,
  type INexxusBaseModel,
  type AnyNexxusModel,
  type AnyNexxusModelData,
  NexxusApplication,
  INexxusApplication,
  NexxusAppModel,
  INexxusAppModel,
  NexxusUser,
  INexxusUser,
  NexxusSetting,
  INexxusSetting,
  NexxusJsonPatch,
  NexxusFilterQuery,
  NexxusLogicalOperator,
  ConnectionException,
  NEXXUS_PREFIX_LC,
  NEXXUS_BUILTIN_MODEL_SCHEMAS,
  isBuiltinModel
} from '@mayhem93/nexxus-core-lib';

import * as ElasticSearch from '@elastic/elasticsearch';
import type { estypesWithBody } from '@elastic/elasticsearch';

type BulkOperationBase = estypesWithBody.BulkOperationBase;
type BulkOperationContainer = estypesWithBody.BulkOperationContainer;
type BulkUpdateAction = estypesWithBody.BulkUpdateAction;
type QueryDslQueryContainer = estypesWithBody.QueryDslQueryContainer;
type QueryDslBoolQuery = estypesWithBody.QueryDslBoolQuery;

import * as path from 'node:path';

type ElasticsearchConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
} & NexxusConfig;

export type ElasticSearchEvents = NexxusDatabaseAdapterEvents & {
  something: [string];
}

/**
 * Elasticsearch-specific stats surfaced by `getStats()`. Cluster-level health
 * plus per-index doc / size info. All fields are optional except `connected`
 * because when the client isn't ready we return `{ connected: false }` and
 * skip the ES calls entirely.
 */
export type NexxusElasticsearchDbStats = NexxusDatabaseAdapterStats & {
  id: string | 'unknown';
  connected: boolean;
  clusterName?: string;
  clusterStatus?: 'green' | 'yellow' | 'red';
  numberOfNodes?: number;
  indices?: Array<{
    name: string;
    docCount: number;
    sizeBytes: number;
    health: 'green' | 'yellow' | 'red';
  }>;
};

type ESBulkRequest = {
  body: Array<BulkOperationBase | BulkOperationContainer | INexxusBaseModel>;
}

export class NexxusElasticsearchDb extends NexxusDatabaseAdapter<ElasticsearchConfig, ElasticSearchEvents, NexxusElasticsearchDbStats> {
  private client: ElasticSearch.Client;
  private collectedIndices: Set<string> = new Set();
  private lastRefreshTimes: Map<string, number> = new Map();

  protected static schemaPath: string = path.join(__dirname, '../../src/schemas/elasticsearch.schema.json');
  protected static envVars: ConfigEnvVars = [
    { name: 'DB_HOST',     location: 'host' },
    { name: 'DB_PORT',     location: 'port' },
    { name: 'DB_USERNAME', location: 'user' },
    { name: 'DB_PASSWORD', location: 'password' }
  ];

  protected static cliArgs: ConfigCliArgs = [];

  constructor(services: INexxusBaseServices) {
    super(services);

    this.client = new ElasticSearch.Client({
      node: `http://${this.config.host}:${this.config.port}`,
      auth: {
        username: this.config.user,
        password: this.config.password
      }
    });
  }

  async connect(): Promise<void> {
    try {
      await this.client.ping({}, { requestTimeout: 2000, maxRetries: 5});

      NexxusElasticsearchDb.logger.debug('Connection established with Elasticsearch database', NexxusDatabaseAdapter.loggerLabel);

      const indices: ElasticSearch.estypes.CatIndicesResponse = await this.client.cat.indices({
        format: 'json',
        h: ['index'],
        index: `${NEXXUS_PREFIX_LC}-*`,
        expand_wildcards: 'open'
      });

      NexxusElasticsearchDb.logger.debug(`Found ${indices.length} indices in Elasticsearch database`, NexxusDatabaseAdapter.loggerLabel);

      indices.forEach(indexInfo => {
        this.collectedIndices.add(indexInfo.index as string);
      });
    } catch (e : Error | unknown) {
      if (e instanceof ElasticSearch.errors.ConnectionError) {
        throw new ConnectionException('Failed to connect to Elasticsearch database');
      } else {
        throw e;
      }
    }
  }

  async reConnect(): Promise<void> {
    // TODO: Implement reconnection logic if needed
  }

  async disconnect(): Promise<void> {
    return this.client.close();
  }

  /**
   * Returns a bootstrapper wired with this adapter's ES client. Called by
   * the Nexxus CLI at deployment provisioning time and by the Hub API on
   * application-lifecycle events. See `NexxusElasticsearchDbBootstrapper`
   * for what ES-specific work runs at each hook.
   */
  public getBootstrapper(): NexxusElasticsearchDbBootstrapper {
    return new NexxusElasticsearchDbBootstrapper(this.client);
  }

  /**
   * Cluster health + per-nexxus-index doc/size info. Two ES round trips (one
   * cluster.health, one cat.indices) — both cheap and observability-safe to
   * poll on a short interval. If either call throws (typical when the client
   * hasn't connected or the cluster is unreachable), we return
   * `{ connected: false }` and let the caller decide what to do.
   *
   * `cat.indices` is scoped to `nxx-*` to match the existing convention in
   * `connect()` — non-nexxus indices in the same cluster don't show up in
   * the stats snapshot.
   */
  async getStats(): Promise<NexxusElasticsearchDbStats> {
    try {
      const health = await this.client.cluster.health();
      const indices = await this.client.cat.indices({
        format: 'json',
        bytes: 'b',
        index: `${NEXXUS_PREFIX_LC}-*`,
        expand_wildcards: 'open',
      });

      return {
        id: health.cluster_name,
        connected: true,
        clusterName: health.cluster_name,
        clusterStatus: health.status as 'green' | 'yellow' | 'red',
        numberOfNodes: health.number_of_nodes,
        indices: indices.map(idx => ({
          name: (idx.index as string) ?? '<unknown>',
          docCount: parseInt((idx as any)['docs.count'] ?? '0', 10),
          sizeBytes: parseInt((idx as any)['store.size'] ?? '0', 10),
          health: ((idx.health as string) ?? 'red') as 'green' | 'yellow' | 'red',
        })),
      };
    } catch {
      return { id: 'unknown', connected: false };
    }
  }

  private async createIndexIfNotExists(indexName: string): Promise<void> {
    if (!this.collectedIndices.has(indexName)) {
      NexxusElasticsearchDb.logger.debug(`Creating index ${indexName} in Elasticsearch database`, NexxusDatabaseAdapter.loggerLabel);

      await this.client.indices.create({ index: indexName });

      NexxusElasticsearchDb.logger.debug(`Index ${indexName} created in Elasticsearch database`, NexxusDatabaseAdapter.loggerLabel);
      this.collectedIndices.add(indexName);
    }
  }

  async createItems(collection: Array<AnyNexxusModel>): Promise<void> {
    const bulkReq : ESBulkRequest = { body: [] };
    let waitForRefresh = true;

    for (const item of collection) {
      let itemData : AnyNexxusModelData;
      let index;

      switch (item.constructor) {
        case NexxusApplication:
          itemData = item.getData();
          index = `${NEXXUS_PREFIX_LC}-application`;

          break;

        case NexxusSetting:
          itemData = item.getData();
          index = `${NEXXUS_PREFIX_LC}-setting`;

          break;

        case NexxusUser:
          itemData = (item as NexxusUser).getData();
          index = `${NEXXUS_PREFIX_LC}-app-${itemData.appId}-${itemData.type}`;

          break;

        case NexxusAppModel:

          itemData = (item as NexxusAppModel).getData();
          index = `${NEXXUS_PREFIX_LC}-app-${itemData.appId}-${itemData.type}`;

          waitForRefresh = false;

          break;
        default:
          throw new Error(`ElasticsearchDb.createItems: Unsupported model type: ${(item as NexxusBaseModel).getData().type}`);
      }

      await this.createIndexIfNotExists(index);

      bulkReq.body.push(
        { index: { _index: index, _id: itemData.id as string } },
        itemData
      );
    }

    NexxusElasticsearchDb.logger.debug('Executing Elasticsearch bulk create', { request: bulkReq }, NexxusDatabaseAdapter.loggerLabel);

    const dbResult = await this.client.bulk({ operations: bulkReq.body, refresh: waitForRefresh ? 'wait_for' : false });

    if (dbResult.errors) {
      const erroredItems = dbResult.items.filter(item => {
        const action = item.index || item.update || item.delete || item.create;

        return action && action.error;
      });

      NexxusElasticsearchDb.logger.error(
        `Failed to create items in Elasticsearch database`,
        { errors: erroredItems },
        NexxusDatabaseAdapter.loggerLabel
      );
    }

    // Back-fill the adapter-assigned version onto each successfully-written AppModel.
    // Built-in models (Application, User) do not carry a version field.
    collection.forEach((item, i) => {
      const indexResult = dbResult.items[i]?.index;

      if (item instanceof NexxusAppModel && indexResult?._version !== undefined) {
        (item.getData() as INexxusAppModel).version = indexResult._version;
      }
    });
  }

  async searchItems(options: NexxusDbSearchOptions<'application'>): Promise<NexxusApplication[]>;
  async searchItems(options: NexxusDbSearchOptions<'user'>): Promise<NexxusUser[]>;
  async searchItems(options: NexxusDbSearchOptions<'setting'>): Promise<NexxusSetting[]>;
  async searchItems(options: NexxusDbSearchOptions<string>): Promise<NexxusAppModel[]>;

  async searchItems(options: NexxusDbSearchOptions<string>): Promise<Array<AnyNexxusModel>> {
    const esSearchRequest = this.buildQuery(options);

    // forceRefresh is a side effect on ES state, not part of query composition,
    // so it stays in searchItems. Only meaningful for app models — built-ins
    // always go through `wait_for` on write.
    if (!isBuiltinModel(options.type) && options.databaseSpecific?.forceRefresh === true) {
      const indexName = esSearchRequest.index as string;
      const lastRefresh = this.lastRefreshTimes.get(indexName);
      const timeSinceRefresh = lastRefresh ? Date.now() - lastRefresh : Infinity;

      // Only refresh if > 500ms since last refresh
      if (timeSinceRefresh > 500) {
        await this.client.indices.refresh({ index: indexName });

        this.lastRefreshTimes.set(indexName, Date.now());

        NexxusElasticsearchDb.logger.debug(
          `Forced refresh of index ${indexName} (last refresh was ${timeSinceRefresh}ms ago)`,
          NexxusDatabaseAdapter.loggerLabel
        );
      }
    }

    NexxusElasticsearchDb.logger.debug('Executing Elasticsearch search', { request: esSearchRequest }, NexxusDatabaseAdapter.loggerLabel);

    const searchResults = await this.client.search(esSearchRequest);

    const models: Array<AnyNexxusModel> = searchResults.hits.hits.map(res => {
      switch (options.type) {
        case 'application':
          return new NexxusApplication(res._source as INexxusApplication);

        case 'user':
          return new NexxusUser(res._source as INexxusUser);

        case 'setting':
          return new NexxusSetting(res._source as INexxusSetting);

        default:
          // Inject the ES-side _version into the model data before construction.
          // Only app models carry a version; built-ins above intentionally don't.
          return NexxusAppModel.fromStorage({
            ...(res._source as INexxusAppModel),
            version: res._version
          });
      }
    });

    return models;
  }

  async getItems(options: NexxusDbGetOptions<'application'>): Promise<Array<NexxusApplication | null>>;
  async getItems(options: NexxusDbGetOptions<'user'>): Promise<Array<NexxusUser | null>>;
  async getItems(options: NexxusDbGetOptions<'setting'>): Promise<Array<NexxusSetting | null>>;
  async getItems(options: NexxusDbGetOptions<string>): Promise<Array<NexxusAppModel | null>>;

  async getItems(options: NexxusDbGetOptions<string>): Promise<Array<NexxusBaseModel | null>> {
    let index : string;

    switch(options.type) {
      case 'application':
        index = `${NEXXUS_PREFIX_LC}-application`;

        break;

      case 'setting':
        index = `${NEXXUS_PREFIX_LC}-setting`;

        break;

      case 'user':
        if (!options.appId) {
          throw new Error("App ID is required for getting user models");
        }

        index = `${NEXXUS_PREFIX_LC}-app-${options.appId}-${options.type}`;

        break;

      default:
        if (!options.appId) {
          throw new Error("App ID is required for getting app-specific models");
        }

        index = `${NEXXUS_PREFIX_LC}-app-${options.appId}-${options.type}`;
    }

    try {
      const esMgetResponse = await this.client.mget({
        index: index,
        ids: options.ids,
        _source: true,
        realtime: true
      });

      return esMgetResponse.docs.map(doc => {
        if ('error' in doc) {
          NexxusElasticsearchDb.logger.warn(`Error retrieving document ID ${doc._id} from Elasticsearch`, { error: doc.error }, NexxusDatabaseAdapter.loggerLabel);

          return null;
        }

        if (!doc.found) {
          return null;
        }

        switch(options.type) {
          case 'application':
            return new NexxusApplication(doc._source as INexxusApplication);

          case 'user':
            return new NexxusUser(doc._source as INexxusUser);

          case 'setting':
            return new NexxusSetting(doc._source as INexxusSetting);

          default:
            // Inject the ES-side _version into the model data before construction.
            return NexxusAppModel.fromStorage({
              ...(doc._source as INexxusAppModel),
              version: doc._version
            });
        }
      }).filter(doc => doc !== null);
    } catch (e: Error | unknown) {
      if (e instanceof ElasticSearch.errors.ResponseError && e.statusCode === 404) {
        return [];
      } else {
        throw e;
      }
    }
  }

  async updateItems(collection: Array<NexxusJsonPatch>, options?: NexxusDbUpdateOptions): Promise<Array<Partial<AnyNexxusModelData>>> {
    const bulkBody: Array<BulkOperationContainer | BulkUpdateAction> = [];
    const collectedModelFields = new Set<string>();
    let waitForRefresh = true;

    if (!(collection[0].get().metadata.type in Object.keys(NEXXUS_BUILTIN_MODEL_SCHEMAS))) {
      waitForRefresh = false;
    }

    // Group all patches targeting the same doc into a single bulk update with one
    // merged painless script. ES bumps `_version` exactly once per `update` action,
    // so emitting separate actions for (e.g.) the field patch and the implicit
    // `updatedAt` patch would double-bump and create phantom gaps on the client.
    type DocBucket = {
      index: string;
      id: string;
      scriptLines: Array<string>;
      scriptParams: Record<string, any>;
      paramCount: number;
    };
    const docBuckets: Map<string, DocBucket> = new Map();

    for (const patch of collection) {
      const patchData = patch.get();
      let index = `${NEXXUS_PREFIX_LC}-`;

      if (patchData.metadata.type === 'application' || patchData.metadata.type === 'setting') {
        index += patchData.metadata.type;
      } else {
        if (!patchData.metadata.appId) {
          throw new Error("App ID is required for updating user or app-specific models");
        }

        index += `app-${patchData.metadata.appId}-${patchData.metadata.type}`;
      }

      const docKey = `${index}|${patchData.metadata.id}`;
      let bucket = docBuckets.get(docKey);

      if (!bucket) {
        bucket = { index, id: patchData.metadata.id, scriptLines: [], scriptParams: {}, paramCount: 0 };
        docBuckets.set(docKey, bucket);
      }

      for (let idx = 0; idx < patchData.path.length; idx++) {
        const path = patchData.path[idx];
        const fieldType = patchData.metadata.pathFieldTypes![idx];
        const paramName = `value${bucket.paramCount}`;
        let scriptLine: string | undefined;

        switch (patchData.op) {
          case 'replace':
            scriptLine = `ctx._source.${path} = params.${paramName}`;

            break;

          case 'append':
            if (fieldType === 'array') {
              scriptLine = `if (ctx._source.${path} == null) { ctx._source.${path} = []; } ctx._source.${path}.add(params.${paramName})`;
            } else if (fieldType === 'string') {
              scriptLine = `if (ctx._source.${path} == null) { ctx._source.${path} = ''; } ctx._source.${path} += params.${paramName}`;
            } else {
              NexxusElasticsearchDb.logger.warn(`Append operation not supported for field type: ${fieldType}`, NexxusDatabaseAdapter.loggerLabel);
            }

            break;

          case 'prepend':
            if (fieldType === 'array') {
              scriptLine = `if (ctx._source.${path} == null) { ctx._source.${path} = []; } ctx._source.${path}.add(0, params.${paramName})`;
            } else if (fieldType === 'string') {
              scriptLine = `if (ctx._source.${path} == null) { ctx._source.${path} = ''; } ctx._source.${path} = params.${paramName} + ctx._source.${path}`;
            } else {
              NexxusElasticsearchDb.logger.warn(`Prepend operation not supported for field type: ${fieldType}`, NexxusDatabaseAdapter.loggerLabel);
            }

            break;

          case 'incr':
            if (fieldType === 'number' || fieldType === 'date') {
              scriptLine = `if (ctx._source.${path} == null) { ctx._source.${path} = ${patchData.value[idx]}; } ctx._source.${path} += params.${paramName}`;
            } else {
              NexxusElasticsearchDb.logger.warn(`Incr operation not supported for field type: ${fieldType}`, NexxusDatabaseAdapter.loggerLabel);
            }

            break;

          case 'decr':
            if (fieldType === 'number' || fieldType === 'date') {
              scriptLine = `if (ctx._source.${path} == null) { ctx._source.${path} = ${patchData.value[idx]}; } ctx._source.${path} -= params.${paramName}`;
            } else {
              NexxusElasticsearchDb.logger.warn(`Decr operation not supported for field type: ${fieldType}`, NexxusDatabaseAdapter.loggerLabel);
            }

            break;
          default:
            NexxusElasticsearchDb.logger.warn(`Unsupported JSON Patch operation: ${patchData.op}`, NexxusDatabaseAdapter.loggerLabel);

            break;
        }

        if (scriptLine === undefined) {
          continue;
        }

        bucket.scriptLines.push(scriptLine);
        bucket.scriptParams[paramName] = patchData.value[idx];
        bucket.paramCount++;
        collectedModelFields.add(path);
      }
    }

    // One update action per doc — single merged script, single `_version` bump.
    for (const bucket of docBuckets.values()) {
      if (bucket.scriptLines.length === 0) {
        NexxusElasticsearchDb.logger.warn(`No valid script lines generated for ID ${bucket.id}`, NexxusDatabaseAdapter.loggerLabel);

        continue;
      }

      bulkBody.push(
        { update: { _index: bucket.index, _id: bucket.id, retry_on_conflict: 3 } },
        {
          script: {
            source: bucket.scriptLines.join(';\n'),
            lang: 'painless',
            params: bucket.scriptParams
          }
        }
      );
    }

    if (bulkBody.length === 0) {
      NexxusElasticsearchDb.logger.warn('No items to update in Elasticsearch database', NexxusDatabaseAdapter.loggerLabel);

      return [];
    }

    NexxusElasticsearchDb.logger.debug('Executing bulk update in Elasticsearch', { bulkBody }, NexxusDatabaseAdapter.loggerLabel);

    const returnFields = options?.returnFields ? collectedModelFields.union(options.returnFields) : collectedModelFields;
    const result = await this.client.bulk({
      operations: bulkBody,
      _source: Array.from(returnFields),
      refresh: waitForRefresh ? 'wait_for' : false
    });
    const collectedPartialModels: Array<Partial<AnyNexxusModelData>> = [];

    NexxusElasticsearchDb.logger.debug('Bulk update result', { result }, NexxusDatabaseAdapter.loggerLabel);

    result.items.forEach(item => {
      if (item.update && item.update.status >= 200 && item.update.status < 300) {
        collectedPartialModels.push({
          id: item.update._id,
          ...(item.update.get!._source),
          // Adapter-assigned post-write version. Meaningful only for app models;
          // for built-in updates the field is technically populated too but
          // ignored downstream (built-ins don't participate in version-based sync).
          version: item.update._version
        } as Partial<AnyNexxusModelData>);
      } else {
        NexxusElasticsearchDb.logger.warn(`Failed to update item ID ${item.update?._id} in Elasticsearch`, { error: item.update?.error }, NexxusDatabaseAdapter.loggerLabel);
      }
    });

    return collectedPartialModels;
  }

  async deleteItems(collection: Array<NexxusBaseModel>): Promise<void> {
    const bulkBody : Array<BulkOperationContainer> = [];

    for (const item of collection) {
      let index;
      let itemData;

      if (item instanceof NexxusApplication) {
        itemData = item.getData();
        index = `${NEXXUS_PREFIX_LC}-application`;
      } else if (item instanceof NexxusSetting) {
        itemData = item.getData();
        index = `${NEXXUS_PREFIX_LC}-setting`;
      } else if (item instanceof NexxusUser) {
        itemData = item.getData();
        index = `${NEXXUS_PREFIX_LC}-app-${itemData.appId}-user`;
      } else {
        itemData = (item as NexxusAppModel).getData();
        index = `${NEXXUS_PREFIX_LC}-app-${itemData.appId}-${itemData.type}`;
      }

      bulkBody.push(
        { delete: { _index: index, _id: itemData.id as string } }
      );
    }

    await this.client.bulk({ operations: bulkBody });
  }

  async countItems(options: NexxusDbCountOptions): Promise<number> {
    const esSearchRequest = this.buildQuery(options);

    NexxusElasticsearchDb.logger.debug('Executing Elasticsearch count', { request: esSearchRequest }, NexxusDatabaseAdapter.loggerLabel);

    const countResult = await this.client.count({
      index: esSearchRequest.index,
      query: esSearchRequest.query
    });

    return countResult.count;
  }

  protected buildQuery(options: NexxusDbSearchOptions<string>): ElasticSearch.estypes.SearchRequest {
    let index = NEXXUS_PREFIX_LC;

    switch (options.type) {
      case 'application': {
        index += `-${options.type}`;

        break;
      }

      case 'setting': {
        index += `-${options.type}`;

        break;
      }

      case 'user': {
        if (!options.appId) {
          throw new Error("App ID is required for searching user models");
        }

        index += `-app-${options.appId}-${options.type}`;

        break;
      }

      default: {
        if (!options.appId) {
          throw new Error("App ID is required for searching app-specific models");
        }

        index += `-app-${options.appId}-${options.type}`;
      }
    }

    return {
      index,
      from: options.offset ?? 0,
      size: options.limit ?? 100,
      query: this.buildFilterQuery(options.filter),
      sort: options.sort
        ? { [options.sort.field]: { order: options.sort.order } }
        : { updatedAt: { order: 'desc' } }
    };
  }

  private buildFilterQuery(filter?: NexxusFilterQuery): QueryDslQueryContainer {
    if (filter === undefined) {
      return { match_all: {} };
    }

    const root: QueryDslQueryContainer = { bool: { must: [] } };
    const stack: Array<{ depth: number; boolQuery: any; operator: NexxusLogicalOperator }> = [];

    let currentBool = root.bool as QueryDslBoolQuery;
    let currentOperator: NexxusLogicalOperator = '$and'; // Root is always AND

    for (const node of filter) {
      // Handle depth changes (pop stack when going back up)
      while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) {
        stack.pop();
      }

      // Update current context from stack
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];

        currentBool = parent.boolQuery;
        currentOperator = parent.operator;
      } else {
        currentBool = root.bool as QueryDslBoolQuery;
        currentOperator = '$and';
      }

      if (node.type === 'logical') {
        // Create new bool query for logical operator
        const newBool : QueryDslQueryContainer = { bool: {} };

        if (node.operator === '$or') {
          newBool!.bool!.should = [];
          newBool!.bool!.minimum_should_match = 1;
        } else {
          newBool!.bool!.must = [];
        }

        // Add to current parent
        if (currentOperator === '$or') {
          (currentBool!.should as QueryDslQueryContainer[]).push(newBool);
        } else {
          (currentBool!.must as QueryDslQueryContainer[]).push(newBool);
        }

        // Push to stack
        stack.push({ depth: node.depth, boolQuery: newBool.bool, operator: node.operator });

      } else if (node.type === 'field') {
        // Build field query
        let fieldQuery: any;

        if (node.operator === 'eq') {
          fieldQuery = { term: { [node.field]: node.value } };
        } else if (node.operator === 'in') {
          fieldQuery = { terms: { [node.field]: node.value } };
        } else if (node.operator === 'ne') {
          fieldQuery = { bool: { must_not: { term: { [node.field]: node.value } } } };
        } else {
          // Range operators (gte, lte, gt, lt).
          fieldQuery = { range: { [node.field]: { [node.operator]: node.value } } };
        }

        // Add to current bool based on parent operator
        if (currentOperator === '$or') {
          if (!currentBool.should) currentBool.should = [];
          (currentBool!.should as QueryDslQueryContainer[]).push(fieldQuery);
        } else {
          if (!currentBool.must) currentBool.must = [];
          (currentBool!.must as QueryDslQueryContainer[]).push(fieldQuery);
        }
      }
    }

    NexxusDatabaseAdapter.logger.debug('Built Elasticsearch query', { query: root }, NexxusDatabaseAdapter.loggerLabel);

    return root;
  }
}
