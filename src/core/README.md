# @mayhem93/nexxus-core-lib

> Foundation package for Nexxus — shared models, DSLs, configuration management, logging, and the base service class every other package builds on.

---

## Overview

The **core** package holds the abstractions the rest of the Nexxus ecosystem depends on:

- the built-in database **models** and the schema shape apps use to declare their own models,
- the **FilterQuery** and **JsonPatch** DSLs used to query and mutate app data,
- the **configuration manager** every node boots from,
- the pluggable **logger**, and
- **`NexxusBaseService`**, the base class for every config-bound service (database/MQ/redis adapters, the logger, and the API/worker nodes themselves).

It has no runtime knowledge of HTTP, queues, or Elasticsearch — those live in the sibling packages that consume it.

---

## Models

Nexxus persists two kinds of records: a handful of **built-in models** the framework owns, and **application models** that app developers declare in their `Application` document's `schema`.

Every model ultimately extends **`NexxusBaseModel`** — the abstract base for all models. It auto-assigns `id` (uuid v4), `createdAt`, and `updatedAt` (both Unix seconds) when absent, and requires a `type`.

### Application

The multi-tenant app definition. Its `schema` field is where an app declares its own models; its optional `auth` block turns authentication on for that tenant.

```jsonc
{
  "id": "3f2a9c1e-…",            // uuid, auto-assigned if omitted
  "type": "application",          // always "application" for this model
  "name": "My Chat App",          // required
  "description": "Realtime chat", // optional

  // Developer-defined models for THIS app. Each entry is a set of field
  // definitions plus two per-model flags (see "Application models" below).
  "schema": {
    "message": {
      "fields": {
        "text":   { "type": "string", "required": true, "filterable": true },
        "roomId": { "type": "string", "required": true, "filterable": true }
      },
      "subscribable": true,   // default true  — clients may subscribe to live changes
      "transient": false      // default false — records can be updated/deleted
    }
  },

  // OPTIONAL. Present only when this app uses authentication. When absent,
  // the app has no Users (see the User model).
  "auth": {
    "jwtSecret": "…",                 // required when auth is present
    "jwtExpiresIn": "7d",             // optional, defaults to "7d"
    "strategies": {                   // must be a subset of api.auth.availableStrategies
      "local": { /* strategy-specific config, validated by the strategy itself */ }
    },
    "userTypes": {                    // optional; a "default" type is always force-injected
      "admin": { "private": true }    // private types can only be created via the Hub API
    },
    "userDetailSchema": {             // per-userType schema for User.details (see User)
      "default": {
        "displayName": { "type": "string", "required": true }
      }
    }
  }
}
```

Two paging fields, `defaultLimit` (default `10`) and `maxLimit` (default `100`), are also accepted and clamp how many records a search/subscribe can return.

> The `Application` constructor validates this document imperatively today (per-model shape, reserved-field names, the invalid `subscribable:false + transient:true` combo, the auth block). JSON-schema validation of the `schema` field itself is intentionally deferred.

### User

Users only exist for apps whose `Application` has a **configured `auth` block** — no auth, no users.

```jsonc
{
  "id": "…",
  "type": "user",
  "appId": "3f2a9c1e-…",     // the owning application
  "userType": "default",      // one of the app's auth.userTypes keys
  "username": "alice",
  "password": "…",            // may be null for OAuth-only accounts
  "authProviders": ["local"], // strategies this user authenticated with
  "devices": ["deviceId-1"],  // device ids currently associated

  // Application-bound free-form data. Its shape is whatever the owning app
  // declared in auth.userDetailSchema[userType] — Nexxus stores whatever the
  // end application needs here.
  "details": {
    "displayName": "Alice"
  }
}
```

The `details` field is the extension point: the app decides its shape per `userType` via `Application.auth.userDetailSchema`, and Nexxus validates writes against it.

### Application models

Anything an app declares under `Application.schema`. Each entry has the shape:

```typescript
{
  fields: NexxusModelDef,   // the field definitions
  subscribable?: boolean,   // default true
  transient?: boolean       // default false
}
```

**Field definitions** (`NexxusModelDef` is a map of field name → definition):

| Kind | Shape |
| --- | --- |
| Primitive | `{ type: 'string' \| 'int' \| 'float' \| 'boolean' \| 'date', required?, nullable?, filterable? }` |
| Object | `{ type: 'object', properties: { …nested field defs… }, required?, nullable? }` |
| Array | `{ type: 'array', arrayType: <primitive> \| 'object', properties? (when arrayType is 'object'), required?, nullable? }` |

- `filterable` applies to **primitive fields only** and defaults to `false`. It gates whether a field may appear in a FilterQuery (see below).
- `date` fields accept a Unix timestamp or ISO string on input and are normalized to integer Unix seconds on write.

**Per-model flags:**

- **`subscribable`** (default `true`) — whether the subscribe route accepts this model. `false` gives a "traditional database" shape: search works, subscribe/unsubscribe are rejected, and *every* primitive field is treated as filterable automatically.
- **`transient`** (default `false`) — create-only. `true` makes update/delete routes reject the model. Meant for notification-shaped records that are produced once and consumed via subscribe/search.
- The combination `subscribable: false && transient: true` is **invalid** (a create-only model that also can't be subscribed to has no observable shape) and is rejected at construction.

### Reserved field names

App model schemas may **not** declare a field with any of these names — they are managed by the framework and rejected by the `Application` constructor:

| Field | Managed by |
| --- | --- |
| `id`, `createdAt`, `updatedAt` | `NexxusBaseModel` |
| `type`, `appId`, `userId` | the API / worker |
| `version` | the database adapter (per-write counter, never user-settable) |

---

## FilterQuery DSL

A database-agnostic, schema-validated query language. It validates a query against a model's field definitions (field existence, primitive type, and the `filterable` flag) and can `test()` an object in-memory.

```typescript
import { NexxusFilterQuery } from '@mayhem93/nexxus-core-lib';

const query = new NexxusFilterQuery(
  {
    $and: [
      { status: "active" },                     // equality — a bare value
      { priority: { in: ["high", "urgent"] } }, // membership
      { createdAt: { gte: 1700000000 } }         // comparison
    ]
  },
  modelDef // NexxusModelDef — the model's field definitions
);

query.test({ status: "active", priority: "high", createdAt: 1700000001 }); // true
```

**Operators** — note these are **bare keywords, not `$`-prefixed**, except the two logical operators:

- Equality: written as a bare value — `{ field: value }` (there is no `eq` keyword to type).
- Comparison: `ne`, `gt`, `gte`, `lt`, `lte`
- Membership: `in` (value must be an array)
- Logical: `$and`, `$or` — the **only** `$`-prefixed operators, each taking an array of sub-queries.

**Rules enforced at construction:**

- `gt` / `gte` / `lt` / `lte` are valid only on `int`, `float`, or `date` fields.
- A field condition may carry only one operator.
- The field must exist in the schema, be primitive, and be `filterable` (nested fields via dot notation, e.g. `"assignee.email"`).
- The universal fields `id`, `createdAt`, `updatedAt` are always queryable.

---

## JsonPatch

A custom patch format tuned for real-time model updates — **not** RFC 6902. Paths use `.` delimiters (dot-prop), and a single patch carries **parallel `path[]` / `value[]` arrays** so several fields can be changed together.

```typescript
import { NexxusJsonPatch } from '@mayhem93/nexxus-core-lib';

const patch = new NexxusJsonPatch({
  op: "replace",
  path:  ["status", "priority"],  // parallel arrays…
  value: ["completed", "low"],    // …same length
  metadata: { appId: "app-123", id: "task-1", type: "task" }
});

patch.validate(appModelSchema);   // REQUIRED before get() — validates + normalizes values
patch.getPartialModel();
// { id: "task-1", type: "task", appId: "app-123", status: "completed", priority: "low" }
```

**Operations** (`op`) and the field types they apply to:

| `op` | Allowed field types | Meaning |
| --- | --- | --- |
| `replace` | any | overwrite the value |
| `append` | `array`, `string` | push onto an array / concatenate onto a string |
| `prepend` | `array`, `string` | unshift onto an array / prepend onto a string |
| `incr` | `int`, `float`, `date` | add to a number |
| `decr` | `int`, `float`, `date` | subtract from a number |

**Metadata:** `{ appId?, id, type, userId? }`. `appId` is required for every model type **except** `setting` (which is deployment-scoped and has no owning app). `validate(schema)` normalizes values in place (e.g. date strings → integer timestamps) and rejects patches that target the reserved `version` field.

This class is constructed and validated by the API when a client submits an update, and by the Writer worker (which, for example, adds its own `replace` patch on `updatedAt` before persisting) — see the `api` and `worker` packages for real call sites.

---

## Configuration management

Every node boots by building a `NexxusConfigManager` — it is what produces the configuration used to instantiate the API/worker and all their services. As each service registers, the manager grafts that service's JSON-schema fragment into one **computed root schema**, then resolves configuration from the provider chain and validates the merged result against that schema. Anything a service requires but that no provider supplied surfaces as a validation error at boot.

### Provider chain

Configuration is layered from four sources, applied in this order (later layers win on a given key):

1. **File** — `nexxus.conf.json` (the base document).
2. **Custom** — provider plugins loaded out-of-band (e.g. AWS Secrets Manager); deep-merged over the file.
3. **CLI** — command-line arguments declared by services.
4. **Environment** — `NXX_`-prefixed env vars declared by services (**highest precedence**).

### Out-of-band `NXX_*` variables

Two variables are read **directly**, before/around the normal pipeline, because they bootstrap the pipeline itself:

**`NXX_CONF_PATH`** — absolute path to the config file (defaults to `/etc/nexxus/nexxus.conf.json`):

```bash
NXX_CONF_PATH=/etc/nexxus/nexxus.conf.json
```

**`NXX_CONFIG_PROVIDERS`** — a JSON array of custom config providers to dynamically import and run. Each entry is `{ provider, export?, options? }`:

```bash
NXX_CONFIG_PROVIDERS='[{"provider":"@myorg/nexxus-aws-secrets-config","options":{"region":"eu-west-1","secretId":"nexxus/prod"}}]'
```

The `options` here (and, similarly, the `options` of a Winston custom transport — see Logging) are **not** defined by core: their shape is dictated by the plugin/package you point at. Core only guarantees the value is valid JSON and hands it to the plugin; the plugin validates the rest.

### Per-service specs

Each service declares its own CLI-arg and env-var specs (a `name`, a dot-path `location`, and a `type`). CLI and env values arrive as strings; the **provider** coerces them to the declared type (`string`, `int`, `float`, `boolean`, or `json` — the latter is `JSON.parse`d and left to schema validation), throwing a clear error on a value that can't be represented. The `NXX_` prefix is prepended to the declared name, so a spec named `API_PORT` reads from `NXX_API_PORT`.

### Fallback logger

Config problems need somewhere to go before the real logger has been resolved, so the config manager stands up a fallback `WinstonNexxusLogger` (stdout, `debug` level, JSON) in its constructor. It is exposed as `configManager.fallbackLogger` and may also be used by the API/worker for early bootstrap logging.

---

## Logging

The default logger is **`WinstonNexxusLogger`**, selected by name in config (`app.logger`). It supports JSON or text output, syslog levels, and pluggable transports — `stdout`, `file`, or any npm Winston transport named by package (with an `options` object handed to that transport's constructor). For most deployments a Winston transport is all you need.

When you need behaviour a Winston transport can't offer, implement a logger directly. Extend `NexxusBaseLogger`, implement `log()` and `getStats()`, and expose a static async `create(services)` factory — the leveled helpers (`info`, `warn`, `error`, …) are provided by the base.

```typescript
import {
  NexxusBaseLogger,
  NexxusLoggerServices,
  NexxusLoggerLevels,
  NexxusConfig,
  type LogAttributes,
} from '@mayhem93/nexxus-core-lib';

type MyLoggerConfig = { level: NexxusLoggerLevels; endpoint: string } & NexxusConfig;

export default class MyCustomLogger extends NexxusBaseLogger<MyLoggerConfig> {
  protected static configRootKey = 'logger';
  protected static schemaPath = '/abs/path/to/my-logger.schema.json';
  protected static envVars = [];
  protected static cliArgs = [];

  // config is passed in — the base logger no longer reads it from the manager
  private constructor(config: MyLoggerConfig) {
    super(config);
    // set up the underlying client from this.config
  }

  // The factory the framework calls; reads its own config section and constructs.
  public static async create(services: NexxusLoggerServices): Promise<MyCustomLogger> {
    const config = services.configManager.getConfig('logger') as MyLoggerConfig;

    return new MyCustomLogger(config);
  }

  public log(level: NexxusLoggerLevels, message: string, attributes?: LogAttributes, label?: string): void {
    // forward to your sink
  }

  public async getStats() {
    return { level: this.config.level };
  }
}
```

A custom logger shipped as its own package must **peer-depend** on `@mayhem93/nexxus-core-lib` so `instanceof` checks resolve against one shared copy.

---

## NexxusBaseService

`NexxusBaseService` is the base class for everything that is bound to the config manager, carries a slice of configuration, emits lifecycle events, and reports stats. That includes the pluggable adapters **and** the API/worker nodes themselves.

```typescript
abstract class NexxusBaseService<
  T extends NexxusConfig,           // this service's config subtree (keyed by its configRootKey)
  Ev extends EventMap = {},         // its typed event map (e.g. { connect: []; disconnect: [] })
  TStats = Record<string, unknown>  // the shape returned by getStats()
> extends TypedEventEmitter<Ev> { … }
```

What it provides:

- A frozen, typed `config` snapshot (its subtree of the root config).
- A typed event emitter — `on` / `once` / `off` / `emit` are all constrained by `Ev`, so, for example, a database adapter can emit `connect` / `disconnect` and callers get compile-time-checked handlers.
- An abstract `getStats(): Promise<TStats>` surfaced by each node's management server and by the Hub.
- Static config hooks — `configRootKey`, `schemaPath`, `envVars`, `cliArgs` — which `ConfigManager.registerService` reads to build the root schema and collect the per-service CLI/env specs.

Services come in two flavors: **constructable** (`new Cls(services)`) and **factory** (`await Cls.create(services)`, for adapters whose init is async — the logger uses this).

Concrete subclasses across the repo:

- Database adapter — [`@mayhem93/nexxus-database-lib`](../database/)
- Message-queue adapter — [`@mayhem93/nexxus-message-queue-lib`](../message_queue/)
- Redis client — [`@mayhem93/nexxus-redis`](../redis/)
- API node — [`@mayhem93/nexxus-api-lib`](../api/)
- Worker nodes — [`@mayhem93/nexxus-worker-lib`](../worker/)

---

## Status

🚧 Pre-alpha. Types and interfaces are still moving; breaking changes land without deprecation shims.

---

## License

MPL-2.0
