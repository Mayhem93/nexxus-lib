import * as ElasticSearch from '@elastic/elasticsearch';
import type { estypesWithBody } from '@elastic/elasticsearch';

import {
  NexxusApplication,
  NexxusModelDef,
  NexxusFieldDef,
  NEXXUS_UNIVERSAL_FIELDS,
  NEXXUS_BUILTIN_MODEL_SCHEMAS,
  NEXXUS_PREFIX_LC,
} from '@mayhem93/nexxus-core-lib';
import { NexxusDatabaseAdapter, NexxusDatabaseBootstrapper } from './DatabaseAdapter';

/**
 * ES mapping shape for a single field. Narrow local type — we only touch a
 * sliver of the ES mapping surface here, so a full `estypes` import would be
 * more machinery than clarity.
 */
type EsFieldMapping =
  | { type: 'keyword' | 'boolean' | 'date' | 'double' }
  | { type: 'object'; properties?: Record<string, EsFieldMapping>; enabled?: boolean }
  | { properties: Record<string, EsFieldMapping> };

type EsIndexMapping = {
  dynamic_templates?: Array<Partial<Record<string, estypesWithBody.MappingDynamicTemplate>>>;
  properties: Record<string, EsFieldMapping>;
};

/**
 * Elasticsearch-specific deployment bootstrapper. Instantiated by
 * `NexxusElasticsearchDb.getBootstrapper()` with the already-connected ES
 * client, so we never open a second connection or duplicate credentials.
 *
 * Explicit mappings are the whole point of this class. The runtime adapter
 * lets ES dynamic-map fields on first write, which loses precision and
 * breaks filter semantics we care about (strings default to `text` +
 * `keyword` multi-field, integers become `long`, decimals become `float`).
 * The bootstrapper declares mappings up front — keyword-only strings, no
 * analyzers anywhere, `double` for every numeric — and installs dynamic
 * templates so any subtree left open in the Nexxus schema inherits the
 * same policy when ES eventually infers a mapping for it.
 */
export class NexxusElasticsearchDbBootstrapper extends NexxusDatabaseBootstrapper {
  private static readonly LOGGER_LABEL = 'NxxDbBootstrap';

  /**
   * Index-level dynamic-mapping rules. Applied to any field ES has to infer
   * on first write (i.e., anything not declared in `properties`). Enforces
   * the Nexxus policy — no analyzers, single numeric type — uniformly
   * across every open-shape subtree of every index we create.
   */
  private static readonly DYNAMIC_TEMPLATES: Array<Partial<Record<string, estypesWithBody.MappingDynamicTemplate>>> = [
    { strings_as_keyword: { match_mapping_type: 'string', mapping: { type: 'keyword' } } },
    { integers_as_double: { match_mapping_type: 'long',   mapping: { type: 'double'  } } },
    { floats_as_double:   { match_mapping_type: 'double', mapping: { type: 'double'  } } },
  ];

  /**
   * `type` lives on every Nexxus document but is deliberately excluded from
   * `NEXXUS_UNIVERSAL_FIELDS` (the field is handled at the query layer via
   * per-type indices). We still map it explicitly so ES's dynamic mapping
   * doesn't fall back to `text` + `keyword` multi-field on first write.
   */
  private static readonly FRAMEWORK_FIELDS_ALL: Record<string, EsFieldMapping> = {
    type: { type: 'keyword' },
  };

  /**
   * App-model documents additionally carry `appId` (always) and `userId`
   * (on user-scoped models). Uniform `keyword` mapping across all app-model
   * indices — harmless for models that never populate `userId`, saves a
   * conditional at mapping-generation time.
   */
  private static readonly FRAMEWORK_FIELDS_APP_MODEL: Record<string, EsFieldMapping> = {
    ...NexxusElasticsearchDbBootstrapper.FRAMEWORK_FIELDS_ALL,
    appId:  { type: 'keyword' },
    userId: { type: 'keyword' },
  };

  constructor(private readonly client: ElasticSearch.Client) {
    super();
  }

  public async bootstrapDeployment(): Promise<void> {
    const appMapping = this.buildMapping(NEXXUS_BUILTIN_MODEL_SCHEMAS.application as NexxusModelDef, false);

    // Mark `schema` and `auth` as `enabled: false`. Both are opaque
    // config blobs on the Application document that we never query at
    // the DB level:
    //   - `schema` grows with every app's every model type — dynamic
    //     mapping would blow past ES's `total_fields.limit` on any
    //     modestly-populated deployment.
    //   - `auth` (and its nested `strategies`) has per-strategy fields
    //     whose value types would collide across strategies if
    //     dynamic-mapped.
    // Both stay in `_source` intact; ES just doesn't index them.
    appMapping.properties.schema = { type: 'object', enabled: false };
    appMapping.properties.auth   = { type: 'object', enabled: false };

    await this.createIndexIfMissing(
      `${NEXXUS_PREFIX_LC}-application`,
      appMapping,
    );

    // Deployment-scoped settings index. One document per setting; the
    // document `id` is the setting name and `value` is an always-JSON
    // string (see NexxusSetting). Nothing here is filterable and nothing
    // needs an override — the schema-to-mapping pass gives us keyword on
    // `value`, and universal + framework fields cover the rest.
    await this.createIndexIfMissing(
      `${NEXXUS_PREFIX_LC}-setting`,
      this.buildMapping(NEXXUS_BUILTIN_MODEL_SCHEMAS.setting as NexxusModelDef, false),
    );
  }

  public async onApplicationCreated(app: NexxusApplication): Promise<void> {
    const appData = app.getData();
    const appId = appData.id as string;
    const schema = app.getSchema();

    // Per-app-per-model indices — one per model type the app declares.
    for (const [modelType, modelSchema] of Object.entries(schema)) {
      await this.createIndexIfMissing(
        `${NEXXUS_PREFIX_LC}-app-${appId}-${modelType}`,
        this.buildMapping(modelSchema, true),
      );
    }

    // User index — only when auth is enabled. `auth.userDetailSchema` is
    // guaranteed present when `auth` is (the Application constructor
    // enforces it); its per-user-type map may be empty {}, in which case
    // the `default` lookup falls through to {} and `details` renders as
    // bare object — the index-level dynamic templates then handle
    // whatever the runtime writes.
    //
    // v1 heuristic: only the `default` user-type's detail schema gets an
    // explicit ES mapping. Multi-user-type deployments still work at the
    // storage layer (non-default types' details land via dynamic
    // templates) but only default gets locked-in-mapping benefits.
    if (appData.auth) {
      const userDetailSchema = (appData.auth.userDetailSchema?.default ?? {}) as NexxusModelDef;

      const userSchema: NexxusModelDef = {
        ...NEXXUS_BUILTIN_MODEL_SCHEMAS.user,
        details: {
          ...NEXXUS_BUILTIN_MODEL_SCHEMAS.user.details,
          properties: userDetailSchema,
        },
      } as NexxusModelDef;

      await this.createIndexIfMissing(
        `${NEXXUS_PREFIX_LC}-app-${appId}-user`,
        this.buildMapping(userSchema, false),
      );
    }
  }

  /**
   * Assemble the full ES `mappings` block for one index. Merge order:
   *   1. `NEXXUS_UNIVERSAL_FIELDS` (id / createdAt / updatedAt) —
   *      framework-invariant, on every Nexxus document.
   *   2. Framework-only fields not covered by the schema (`type`, plus
   *      `appId` / `userId` for app models).
   *   3. Schema-derived properties.
   *
   * Later spreads win in case of collision, but `NEXXUS_RESERVED_FIELD_NAMES`
   * blocks any schema from declaring reserved names at registration — so
   * in practice there's no collision path here.
   */
  private buildMapping(schema: NexxusModelDef, isAppModel: boolean): EsIndexMapping {
    return {
      dynamic_templates: NexxusElasticsearchDbBootstrapper.DYNAMIC_TEMPLATES,
      properties: {
        ...NexxusElasticsearchDbBootstrapper.schemaToEsMappings(NEXXUS_UNIVERSAL_FIELDS as NexxusModelDef),
        ...(isAppModel
          ? NexxusElasticsearchDbBootstrapper.FRAMEWORK_FIELDS_APP_MODEL
          : NexxusElasticsearchDbBootstrapper.FRAMEWORK_FIELDS_ALL),
        ...NexxusElasticsearchDbBootstrapper.schemaToEsMappings(schema),
      },
    };
  }

  private static schemaToEsMappings(schema: NexxusModelDef): Record<string, EsFieldMapping> {
    const properties: Record<string, EsFieldMapping> = {};

    for (const [name, def] of Object.entries(schema)) {
      properties[name] = NexxusElasticsearchDbBootstrapper.fieldToEsMapping(def);
    }

    return properties;
  }

  /**
   * Map a single Nexxus field def to an ES field mapping.
   *
   *   string  → keyword         (no analyzers, no text)
   *   number  → double          (Nexxus doesn't split int/float today;
   *                              `double` is the safe superset — accepts
   *                              JS-safe ints and floats without loss)
   *   boolean → boolean
   *   date    → date
   *   array   → element-type mapping; ES arrays are just repeated values
   *             of the element type, no wrapper mapping.
   *   object  → explicit `properties` when the schema declares them, bare
   *             `type: object` otherwise (index-level dynamic templates
   *             handle any sub-fields at write time).
   */
  private static fieldToEsMapping(def: NexxusFieldDef): EsFieldMapping {
    switch (def.type) {
      case 'string':  return { type: 'keyword' };
      case 'number':  return { type: 'double'  };
      case 'boolean': return { type: 'boolean' };
      case 'date':    return { type: 'date'    };
      case 'array':
        if (def.arrayType === 'object') {
          return def.properties && Object.keys(def.properties).length > 0
            ? { properties: NexxusElasticsearchDbBootstrapper.schemaToEsMappings(def.properties) }
            : { type: 'object' };
        }

        return NexxusElasticsearchDbBootstrapper.fieldToEsMapping({ type: def.arrayType } as NexxusFieldDef);
      case 'object':
        return Object.keys(def.properties).length > 0
          ? { properties: NexxusElasticsearchDbBootstrapper.schemaToEsMappings(def.properties) }
          : { type: 'object' };

      default:
        throw new Error(`fieldToEsMapping: unhandled field def ${JSON.stringify(def)}`);
    }
  }

  /**
   * Idempotent create. Two round trips (exists + create) — bootstrap runs
   * rarely; correctness over latency.
   */
  private async createIndexIfMissing(index: string, mappings: EsIndexMapping): Promise<void> {
    const exists = await this.client.indices.exists({ index });

    if (exists) {
      NexxusDatabaseAdapter.logger.info(
        `Index ${index} already exists — skipping`,
        NexxusElasticsearchDbBootstrapper.LOGGER_LABEL,
      );

      return;
    }

    await this.client.indices.create({ index, mappings });

    NexxusDatabaseAdapter.logger.info(
      `Created index ${index}`,
      NexxusElasticsearchDbBootstrapper.LOGGER_LABEL,
    );
  }
}
