# @mayhem93/nexxus-database-lib

> Database abstraction for Nexxus — a pluggable adapter contract plus a built-in Elasticsearch implementation.

---

## Overview

This package defines **how Nexxus talks to a database** without committing to any particular one. It gives you:

- **`NexxusDatabaseAdapter`** — the abstract contract every adapter implements (CRUD over model instances, search, count, connection lifecycle).
- **`NexxusDatabaseBootstrapper`** — the deployment-time hook that provisions storage (indices / tables / collections) for a deployment and for each application.
- A built-in **Elasticsearch** adapter and bootstrapper.

The adapter's job is to translate Nexxus's database-agnostic constructs — the **FilterQuery** DSL and **JsonPatch** — into whatever the underlying engine speaks, and to persist/return the framework's model objects. This README is written for **adapter authors**: the Elasticsearch adapter is the reference implementation, not the subject.

---

## Features

- **Pluggable adapter contract** — implement `NexxusDatabaseAdapter` for any store; the API/worker code never knows which engine is behind it.
- **FilterQuery translation** — a validated, engine-neutral query DSL each adapter lowers to its native query language.
- **JsonPatch translation** — the framework's patch ops mapped onto native update mechanisms.
- **Collection / bulk operations** — every operation takes a collection, so batching is the default rather than an afterthought.
- **Connection liveness** — adapters report `connect` / `disconnect` events that the API/worker use to gate availability.
- **Deployment bootstrapping** — a separate contract for one-shot deployment setup and per-application provisioning.

---

## The adapter interface

`NexxusDatabaseAdapter` extends core's `NexxusBaseService`, so an adapter is a config-bound service with a typed config slice, typed events, and `getStats()`:

```typescript
abstract class NexxusDatabaseAdapter<
  T extends NexxusConfig,                     // the adapter's "database" config subtree
  Ev extends NexxusDatabaseAdapterEvents,     // connect / disconnect / error
  TStats extends NexxusDatabaseAdapterStats = {}
> extends NexxusBaseService<T, Ev, TStats> { … }
```

The operations an adapter must implement — note everything is a **collection** and works on **model instances**, not plain objects:

| Method | Purpose |
| --- | --- |
| `connect()` / `disconnect()` | Open/close the connection; drive the `connect`/`disconnect` events. |
| `getBootstrapper()` | Return this adapter's `NexxusDatabaseBootstrapper` (see below). |
| `createItems(collection: AnyNexxusModel[])` | Persist model instances. |
| `getItems({ ids, type, appId? })` | Fetch by id (returns `null` per missing id, per model type). |
| `searchItems({ type, appId?, filter?, limit?, offset?, sort?, databaseSpecific? })` | Query with a `NexxusFilterQuery`. |
| `updateItems(patches: NexxusJsonPatch[], { returnFields? })` | Apply patches; optionally return the changed fields. |
| `deleteItems(collection: NexxusBaseModel[])` | Delete by model instance. |
| `countItems({ type, appId?, filter? })` | Count matching documents. |
| `buildQuery(options)` *(protected)* | Adapter-internal: translate search options into the native query. |

Typical caller usage (the API and workers, not end users):

```typescript
// create — pass model instances, not raw JSON
await db.createItems([ new NexxusAppModel(data, app.getSchema()) ]);

// read by id
const [task] = await db.getItems({ type: 'task', ids: ['task-1'], appId: 'app-123' });

// search
const tasks = await db.searchItems({
  type: 'task',
  appId: 'app-123',
  filter: new NexxusFilterQuery({ $and: [{ status: 'todo' }] }, taskSchema),
  sort: { field: 'createdAt', order: 'desc' },
  limit: 20,
  offset: 0,
});

// update — patches are validated NexxusJsonPatch instances
const [changed] = await db.updateItems([patch], { returnFields: new Set(['status']) });

// delete / count
await db.deleteItems([taskModel]);
const total = await db.countItems({ type: 'task', appId: 'app-123' });
```

`getItems` and `searchItems` are overloaded by `type` so built-in models resolve to their concrete classes (`NexxusApplication`, `NexxusUser`, `NexxusSetting`) and everything else to `NexxusAppModel`.

---

## FilterQuery translation

Callers never write engine queries. They build a `NexxusFilterQuery` — a small, schema-validated DSL (`$and`/`$or` plus `ne`/`gt`/`gte`/`lt`/`lte`/`in` and bare-value equality). Core validates it against the model's field definitions (field exists, is primitive, is `filterable`) *before* it reaches the adapter, so by the time an adapter sees it, it's a well-formed tree of nodes.

Each adapter's job is simply to **walk that tree and emit its native equivalent** — bool/must/should for a search engine, a `WHERE` clause for SQL, a query document for a document store, and so on. Because validation and shape live in core, adapters share one query surface and one set of guarantees; the only per-adapter code is the lowering.

The built-in Elasticsearch adapter lowers it to a `bool` query:

```jsonc
// FilterQuery input
{
  "$and": [
    { "status": { "in": ["todo", "in_progress"] } },
    { "priority": { "gte": 5 } },
    { "$or": [
      { "assignee.email": "dev@example.com" },
      { "team": "backend" }
    ]}
  ]
}
```

```json
// Elasticsearch output
{
  "bool": {
    "must": [
      { "terms": { "status": ["todo", "in_progress"] } },
      { "range": { "priority": { "gte": 5 } } },
      { "bool": { "should": [
        { "term": { "assignee.email": "dev@example.com" } },
        { "term": { "team": "backend" } }
      ] } }
    ]
  }
}
```

---

## JsonPatch translation

Updates arrive as validated `NexxusJsonPatch` instances whose ops are `replace`, `append`, `prepend`, `incr`, and `decr` (with parallel `path[]`/`value[]` arrays). An adapter maps those ops onto its engine's native update mechanism: a scripted update, a SQL `UPDATE` with the right expressions, a document-store update operator (`$set`, `$inc`, `$push`, …), etc. The important part is preserving each op's semantics — `incr`/`decr` are relative arithmetic, `append`/`prepend` mutate arrays/strings — and applying all of a document's patches atomically where the engine allows.

The Elasticsearch adapter compiles the patches for a document into a single painless script (one script per document, so its `_version` bumps exactly once):

```painless
// replace status; incr viewCount
ctx._source.status = params.value0;
ctx._source.viewCount += params.value1;
```

Values are passed as script `params` (never string-interpolated), and paths are validated against the model schema before the script is built.

---

## Deployment bootstrapping

Runtime CRUD assumes storage already exists. Standing that storage up is a **separate concern** handled by `NexxusDatabaseBootstrapper`, obtained from an adapter via `getBootstrapper()` (so it reuses the adapter's already-connected client rather than opening its own). It has two idempotent hooks:

- **`bootstrapDeployment()`** — one-shot, deployment-wide setup: the base infrastructure the runtime expects to exist (base indices / tables / collections). Run by the Nexxus CLI at provisioning time; must be a safe no-op on re-run.
- **`onApplicationCreated(app)`** — provisions per-application storage when a new application is created (via Hub or CLI). Also idempotent, so Hub can replay an `app_created` event after a restart.

Migration (framework upgrades, schema evolution, data rewrites) is **explicitly out of scope** for this contract.

For Elasticsearch this is where **explicit mappings** get declared — the whole reason the bootstrapper exists. Left to itself, ES dynamic-maps fields on first write, which breaks the filter semantics Nexxus wants (strings become analyzed `text`+`keyword`, decimals become `float`). `NexxusElasticsearchDbBootstrapper` instead:

- creates the deployment-scoped `nxx-application` and `nxx-setting` indices in `bootstrapDeployment()`, and one `nxx-app-<appId>-<modelType>` index per declared model (plus `nxx-app-<appId>-user` when the app has auth) in `onApplicationCreated()`;
- maps Nexxus types deliberately — `string → keyword` (no analyzers), `int → long`, `float → double`, `date → date`, `boolean → boolean` — and installs dynamic templates so any open subtree inherits the same policy;
- marks the Application document's `schema` and `auth` blobs `enabled: false` (stored in `_source`, never indexed);
- skips `transient` models, which never reach the database.

---

## Writing a custom adapter

To add support for a new store, ship a package that:

1. **Extends `NexxusDatabaseAdapter<Config, Events, Stats>`** and sets the static config hooks it inherits from `NexxusBaseService` — `configRootKey` is already `'database'`; you provide `schemaPath` (a JSON schema for your config) and any `envVars` / `cliArgs` specs.
2. **Implements the operations** in the interface table above. Remember the inputs are framework objects: `createItems` receives model instances (`getData()` to read them), `updateItems` receives `NexxusJsonPatch` instances (`get()` after `validate()`), `deleteItems` receives `NexxusBaseModel` instances.
3. **Lowers FilterQuery and JsonPatch** to native queries/updates in `searchItems`/`buildQuery` and `updateItems` respectively.
4. **Drives the lifecycle events** — resolve `connect()` on first successful connection and keep retrying rather than failing fast; emit `disconnect` when the connection drops and `connect` when it returns. The API/worker gate request availability on these, so getting them right matters more than the CRUD.
5. **Preserves the `version` field** — it's a per-write counter the client uses for gap detection. Assign/return it on writes the way ES surfaces `_version`; a store without a native document version needs its own monotonic counter (see the write-concurrency notes in core).
6. **Provides a `NexxusDatabaseBootstrapper` subclass** via `getBootstrapper()` for deployment/app provisioning.

Package it with `@mayhem93/nexxus-core-lib` as a **peer dependency** so `instanceof` checks resolve against a single shared copy, then point `app.database` at your package name in config — the framework dynamic-imports it.

---

## Configuration

An adapter's config lives under the `database` key of the root config and must be backed by a **JSON schema** (`schemaPath`) so the config manager can validate it. See the built-in schema at [`src/schemas/elasticsearch.schema.json`](src/schemas/elasticsearch.schema.json) for the shape (`host`, `port`, `user`, `password`).

Adapters may also declare `envVars` / `cliArgs` specs (see the core config manager). The Elasticsearch adapter declares env vars only, each `NXX_`-prefixed and typed so the value is coerced:

| Env var | Config path | Type |
| --- | --- | --- |
| `NXX_DB_HOST` | `database.host` | string |
| `NXX_DB_PORT` | `database.port` | int |
| `NXX_DB_USERNAME` | `database.user` | string |
| `NXX_DB_PASSWORD` | `database.password` | string |

Anything a service requires but no provider supplies fails validation against the computed schema at boot.

---

## Built-in adapter: Elasticsearch

`NexxusElasticsearchDb` is the reference adapter. Rather than argue *why* Elasticsearch, here's what it does that's ES-specific:

- **Index-per-type, per-app layout** — `nxx-application` and `nxx-setting` are deployment-scoped; app data lives in `nxx-app-<appId>-<modelType>` (and `nxx-app-<appId>-user` when auth is enabled). The document `type` is expressed by the index it lives in rather than a filtered field.
- **Explicit, analyzer-free mappings** declared by the bootstrapper (see above), with dynamic templates enforcing the same policy for open subtrees.
- **Scripted bulk updates** — a document's patches merge into one painless script so `_version` bumps once; conflicts use `retry_on_conflict`. That `_version` becomes the model's `version`.
- **Reactive liveness** — `connect()` retries until ES answers, then a background ping loop (relaxed while connected, aggressive while down) flips the `connect`/`disconnect` events the API listens on.
- **Write visibility** — app-model writes don't force a refresh; built-in model writes wait for one, so control-plane reads are immediately consistent.

---

## Key classes

- **`NexxusDatabaseAdapter`** *(abstract)* — the adapter contract; extends `NexxusBaseService`.
- **`NexxusDatabaseBootstrapper`** *(abstract)* — deployment + per-application provisioning contract.
- **`NexxusElasticsearchDb`** — built-in Elasticsearch adapter.
- **`NexxusElasticsearchDbBootstrapper`** — built-in ES bootstrapper (index + mapping creation).
- **`NexxusDatabaseException` / `NexxusDatabaseUpdateConflictException`** — adapter error types; the conflict exception carries the offending `id`/`appId`.

---

## Status

🚧 Pre-alpha. The adapter and bootstrapper contracts are still moving; breaking changes land without deprecation shims.

## License

MPL-2.0
