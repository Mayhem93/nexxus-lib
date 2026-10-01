# @mayhem93/nexxus-api-lib

> The Nexxus API server as a library: HTTP routes, authentication, sessions, devices, subscriptions and model operations for every application in a deployment.

---

## Overview

`NexxusApi` is an Express 5 server. Construct it with the deployment's logger, database, message-queue and Redis services, call `init()`, and it serves every application stored in the database. Each request names its application in the `nxx-app-id` header.

The ready-to-run server is [nexxus-api](https://github.com/Mayhem93/nexxus-api) (Docker image `razvanbotea/nexxus-api`), built on this package. Use the package directly to write your own entry point, or to build an auth strategy.

An application either **has authentication** — users sign in, and every token names a user and a device — or **has none**, in which case clients register devices and every token names only a device.

Where a request goes:

- **Model writes** — create, patch, delete — are validated against the model's schema and, on applications with access control, the caller's roles. They are queued for the Writer worker and answered with `202 Accepted`; the change is applied shortly after.
- **Transient models** are never stored. Creating one goes straight to the Transport Manager, which notifies subscribers.
- **Model reads** — get, search, count — query the database.
- **User accounts** are written to the database directly.
- **Devices, sessions and subscriptions** are stored in Redis.

The HTTP reference is [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1), included in the published package. Any OpenAPI 3.1 renderer turns it into a page, e.g. `npx @redocly/cli build-docs openapi.yaml`.

---

## Installation

```bash
npm install @mayhem93/nexxus-api-lib @mayhem93/nexxus-core-lib @mayhem93/nexxus-database-lib @mayhem93/nexxus-message-queue-lib @mayhem93/nexxus-redis
```

The four packages after the API are peer dependencies. Requires Node.js 24 or later.

---

## Running the API

```js
import { NexxusConfigManager } from '@mayhem93/nexxus-core-lib';
import { NexxusRedis } from '@mayhem93/nexxus-redis';
import { NexxusApi } from '@mayhem93/nexxus-api-lib';

const configManager = new NexxusConfigManager('./nexxus-api.conf.json');

await configManager.validateServices([ NexxusRedis, NexxusApi ]);

const config = configManager.getConfig('app');

// Built-in class names resolve directly; anything else is imported as an npm package.
const LoggerClass = await NexxusApi.resolveFactoryService(configManager, config.logger);
const DbClass     = await NexxusApi.resolveConstructableService(configManager, config.database);
const MqClass     = await NexxusApi.resolveConstructableService(configManager, config.message_queue);

// Validates the config sections the resolved classes declare.
await configManager.validateServices();

const logger = await LoggerClass.create({ configManager });
const api = new NexxusApi({
  configManager,
  logger,
  database:     new DbClass({ configManager, logger }),
  messageQueue: new MqClass({ configManager, logger }),
  redis:        new NexxusRedis({ configManager, logger }),
});

await api.init();

process.once('SIGTERM', () => api.close());
process.once('SIGINT',  () => api.close());
```

`init()`, in order:

1. Connects to the database, message queue and Redis, and waits until all three are up.
2. Loads the strategies listed in `app.auth.availableStrategies`.
3. Loads every application, with its ACL roles.
4. Sets up each application's strategies from its `auth.strategies` config.
5. Starts listening on `app.port` — over HTTPS when `app.ssl` is set.
6. Starts the management server on `app.management.port`.
7. Registers with the Hub, when `app.hub` is set.

`close()` deregisters from the Hub, stops the management server, stops accepting connections and waits for in-flight requests to finish, then disconnects from the database, message queue and Redis.

`init()` rejects, and the API doesn't start, when:

- an application enables a strategy that isn't in `app.auth.availableStrategies`;
- an application's strategy config fails that strategy's schema — the error names the application, the strategy and the field;
- a strategy package can't be imported, doesn't default-export a class extending `Auth.NexxusAuthStrategy`, or is named `refresh` or `logout`;
- an ACL role doesn't validate against its application's schema, or a user type names a role that doesn't exist.

---

## Configuration

The API reads the `app` section of the config file. The `database`, `message_queue`, `redis` and `logger` sections belong to the adapters — see their packages for every key. How the file is found, and layered with environment variables, is described in [`nexxus-core-lib`](../core/README.md#configuration-management).

```jsonc
{
  "app": {
    "name": "api-1",
    "port": 5000,
    "logger": "WinstonNexxusLogger",
    "database": "NexxusElasticsearchDb",
    "message_queue": "NexxusRabbitMq",
    "auth": { "availableStrategies": [ "local", "google" ] },
    "management": { "port": 9001, "token": "<management token>" },
    "hub": { "endpoint": "http://hub.internal:9000", "token": "<hub token>" }
  },
  "database":      { "host": "localhost", "port": 9200 },
  "message_queue": { "host": "localhost", "port": 5672, "user": "nexxus", "password": "<password>" },
  "redis":         { "host": "localhost", "port": 6379 },
  "logger":        { "level": "info", "logType": "json", "transports": [ { "type": "stdout" } ] }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Name of this node. |
| `port` | no | HTTP(S) port. Default `5000`. |
| `logger` | yes | Logger class: `WinstonNexxusLogger`, or an npm package name. |
| `database` | yes | Database adapter: `NexxusElasticsearchDb`, or an npm package name. |
| `message_queue` | yes | Message-queue adapter: `NexxusRabbitMq`, or an npm package name. |
| `ssl.sslKeyPath`, `ssl.sslCertPath` | no | PEM key and certificate. When set, the API serves HTTPS only and sends `Strict-Transport-Security`. |
| `auth.availableStrategies` | no | Strategies this deployment offers: `local`, `google`, or npm package names. Applications can only enable strategies listed here. |
| `management.port`, `management.token` | yes | Port and bearer token of the management server. |
| `hub.endpoint`, `hub.token` | no | Hub to register with. Without it the API runs standalone. |

Three keys can be set from the environment: `NXX_API_PORT`, `NXX_API_MANAGEMENT_PORT` and `NXX_API_MANAGEMENT_TOKEN`.

With `NODE_ENV=dev`, error responses include the stack trace.

### Per-application settings

These live on each application's document (see [`nexxus-core-lib`](../core/README.md#application)). The API reads them at startup.

| Field | Meaning |
| --- | --- |
| `signingSecret` | Signs the application's tokens. |
| `session.jwtExpiresIn` | Access-token lifetime in seconds, 600–7200. Default `3600`. |
| `session.refreshTokenExpiresIn` | Session lifetime in seconds, 86400–31536000. Default 30 days. |
| `auth.strategies.<name>` | Enables a strategy for this application, with its config — see [Authentication](#authentication). |
| `auth.userTypes.<type>.roles` | ACL roles granted to a user type — see [Access control](#access-control). |
| `auth.userDetailSchema.<type>` | Fields a user of that type keeps in `details`. Registration and `PUT /user` are validated against it. |
| `auth.acl` | `true` turns on access control. |

---

## Routes

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/` | Service greeting. |
| `POST` | `/auth/{strategy}` | Signs in with one of the application's strategies. |
| `GET` | `/auth/{strategy}/callback` | Where an OAuth provider redirects back; completes the sign-in. |
| `POST` | `/auth/refresh` | Exchanges a refresh token for a new token pair. |
| `POST` | `/auth/logout` | Ends the session a refresh token belongs to. |
| `POST` | `/user/register` | Creates an account with a username and password, and signs it in. |
| `GET` | `/user/me` | The signed-in user. |
| `PUT` | `/user` | Updates the signed-in user. |
| `POST` | `/device/register` | Creates a device and returns a session for it. |
| `GET` | `/device/list` | The signed-in user's devices. |
| `GET` | `/device` | The calling device. |
| `PUT` | `/device` | Renames the calling device. |
| `POST` | `/model` | Creates a model instance. |
| `POST` | `/model/count` | Counts matching instances. |
| `POST` | `/model/{type}/search` | Searches instances of a model. |
| `GET` | `/model/{id}` | Reads one instance. |
| `PUT` | `/model/{id}` | Patches one instance. |
| `DELETE` | `/model/{id}` | Deletes one instance. |
| `POST` | `/subscription` | Subscribes the calling device to a channel. Returns the first page of data and the channel id. |
| `DELETE` | `/subscription` | Unsubscribes the calling device from a channel. |

`POST /auth/{strategy}` exists for every strategy in `app.auth.availableStrategies`, and the callback for those that use one (`google`). An application that doesn't enable the strategy gets `404`.

---

## Requests and errors

- Every route except `GET /` and `GET /auth/{strategy}/callback` requires the `nxx-app-id` header. It is not a secret.
- Tokens go in `Authorization: Bearer <token>`. On an application with authentication, every route needs one except `GET /`, `/user/register` and the `/auth/*` routes. On an application without authentication, only `/device` and `/subscription` need one — the token from `/device/register`.
- Dates are UNIX timestamps in seconds.

Every error has the same body, with the HTTP status set to match:

```json
{ "error": "AccessDeniedException", "message": "Access denied" }
```

While the database, the message queue or Redis is disconnected, every request is answered `503 ServiceUnavailableException`. Requests are served again as soon as it reconnects.

Each request is logged at `info` when it completes, with its method, URL, status and duration. Errors with a `5xx` status are logged at `error`, others at `info`.

---

## Sessions and devices

`/user/register`, `/auth/{strategy}` and `/device/register` return a session: a `token`, a `refreshToken`, and the `device` both are bound to.

- **`token`** is the access token, sent as `Authorization: Bearer <token>`. It names the device, and also the user on an application with authentication. It lasts the application's `session.jwtExpiresIn` (default 1 hour); after that, requests get `401 UserTokenExpiredException`.
- **`refreshToken`** goes to `POST /auth/refresh`, which returns a new `token` and `refreshToken`. The session ends `session.refreshTokenExpiresIn` after it started (default 30 days), however often it is refreshed. After that, `/auth/refresh` answers `401 InvalidRefreshTokenException`, and the user signs in again.
- A refresh token works once. The one it replaced is still accepted for 10 seconds, so a retried refresh succeeds; presented any later, it ends the session.
- `POST /auth/logout` ends the session and closes the device's live transport connection. It answers `200` whether or not the refresh token was valid.
- Applications without authentication refresh and log out the same way.

Which device a session is bound to:

- `/user/register`, and a first sign-in through an OAuth provider, create the account's first device.
- `POST /auth/local`, and later OAuth sign-ins, reuse the device sent as `"device": { "id": "…" }` when it belongs to the user, and create one otherwise.
- `POST /device/register` always creates a device. On an application without authentication, it is how a client gets a session.

---

## Authentication

`local` and `google` are built in. `app.auth.availableStrategies` lists the strategies a deployment offers; each application enables some of them under `auth.strategies`, each with its own config.

| Strategy | `auth.strategies.<name>` | Sign-in |
| --- | --- | --- |
| `local` | `{}` | `POST /auth/local` with `username` and `password`. Accounts are created with `POST /user/register`. |
| `google` | `clientID`, `clientSecret` and `callbackURL`, all required and non-empty. | `POST /auth/google` redirects to Google, which redirects back to `GET /auth/google/callback`; that response carries the session. `callbackURL` must be this API's callback URL, registered with Google. |

Signing in with Google creates the account on first use, or links Google to the existing account with the same email. Only verified Google emails are accepted.

### Third-party strategies

Any other name in `availableStrategies` is imported as an npm package from the app's `node_modules`. The package must default-export a class extending `Auth.NexxusAuthStrategy`, and peer-depend on `@mayhem93/nexxus-api-lib`.

```typescript
import { Auth } from '@mayhem93/nexxus-api-lib';
import type { NexxusUserDetailSchema } from '@mayhem93/nexxus-core-lib';
import type { NextFunction, Request, Response } from 'express';

type GithubConfig = { clientID: string; clientSecret: string };

export default class GithubAuthStrategy extends Auth.NexxusAuthStrategy<GithubConfig> {
  readonly name = '@acme/nexxus-github-auth';                          // exactly the availableStrategies entry
  static readonly requiresCallback = true;                               // also mounts GET /auth/<name>/callback
  static userDetailSchema: NexxusUserDetailSchema = { login: { type: 'string', required: false } };
  protected static schemaPath = '/abs/path/to/github-auth.schema.json';  // validates auth.strategies.<name>

  initializePassport(): void { /* passport.use(this.passportName, …) */ }

  async handleAuth(req: Request, res: Response, next: NextFunction): Promise<void> { /* POST /auth/<name> */ }

  async handleCallback(req: Request, res: Response, next: NextFunction): Promise<void> { /* GET /auth/<name>/callback */ }
}
```

- At startup, one instance is created per application that enables the strategy, with that application's config.
- `name` must be exactly the string listed in `availableStrategies`.
- `userDetailSchema` fields are stored on the user under `details.$auth_<name>`, and are never sent to clients.
- To finish a sign-in, call `sendSessionForExistingUser(res, user, deviceHint)` or `sendSessionForNewUser(res, user)`. `findOrCreateUser()` returns the user, and whether it was just created.
- Pass failures to `next()` as this package's exceptions: `UserAuthenticationFailedException` is answered `401`, `InvalidParametersException` `400`. Any other error is answered `500`.
- A redirect flow can carry data through the provider with `signState()` and `verifyState()`. `NexxusAuthNonce` from `@mayhem93/nexxus-redis` makes it single-use.

---

## Access control

With `auth.acl: true`, model and subscription requests are checked against the roles of the caller's user type. A denied request gets `403 AccessDeniedException`.

Roles are `acl` records of the application, loaded at startup. A role's `statements` field holds a JSON-encoded list of statements:

```jsonc
[
  { "effect": "Allow", "action": [ "read" ], "resource": [ "message" ] },
  {
    "effect": "Allow",
    "action": [ "create", "update", "delete" ],
    "resource": [ "message" ],
    "condition": { "StringEquals": { "userId": [ "$nxx:userId" ] } }
  },
  { "effect": "Deny", "action": [ "*" ], "resource": [ "auditLog" ] }
]
```

- **`action`** — `create`, `get`, `search`, `count`, `update`, `delete`, `subscribe` (also covers unsubscribe); or `read` (get, search, count, subscribe), `write` (create, update, delete) and `*`.
- **`resource`** — model names, or `*`.
- **`condition`** — Allow statements only. `StringEquals`, `StringNotEquals`, `NumericEquals` and `NumericNotEquals` each map a field to the values it may hold: literals, or `$nxx:userId`, `$nxx:userType`, `$nxx:appId`. Values for one field are OR-ed; fields and operators are AND-ed. A condition can name `id`, `userId` and `createdAt`, or — when `resource` lists models — a field declared `acl: true` and `filterable: true` on them.
- A Deny wins over any Allow. When no role allows an action, it is denied.

How roles apply:

- `auth.userTypes.<type>.roles` lists a user type's roles. A user type without roles is denied everything.
- The `default` user type always has the built-in `DefaultFullAccess` role, which allows everything. An application's own `default` entry is replaced.
- `search` and `subscribe` return only the rows a role's conditions allow. `create`, `get`, `update` and `delete` on any other row get `403`. `count` checks the action only, and counts every matching row.

---

## Management server and Hub

The management server answers `GET /stats` on `app.management.port`, with `Authorization: Bearer <app.management.token>`; a missing or wrong token gets `401`.

```json
{ "uptime": 812.4, "port": 5000, "loadedApps": 3, "authStrategies": [ "local", "google" ], "authEnabled": true, "logger": { } }
```

With `app.hub` set, the API registers with the Hub as role `api` once it is listening, retrying until the Hub answers, and deregisters on `close()`. An unreachable Hub doesn't stop the API from serving.

---

## Known limitations

- Applications and their ACL roles are read once, at startup. Restart the API after creating or changing an application or a role.
- With the built-in Elasticsearch adapter, only the first 100 applications are loaded.
- The API sends no CORS headers. A browser client served from another origin needs a proxy in front of the API that adds them.
- `auth.userTypes.<type>.private` isn't enforced yet: any user type an application declares can be chosen at registration.

---

## Related packages

- [`@mayhem93/nexxus-core-lib`](../core/) — application and user models, FilterQuery, JsonPatch, configuration, logging.
- [`@mayhem93/nexxus-worker-lib`](../worker/) — the Writer, Transport Manager and transport workers that apply queued writes and deliver updates.
- [`@mayhem93/nexxus-database-lib`](../database/), [`@mayhem93/nexxus-message-queue-lib`](../message_queue/), [`@mayhem93/nexxus-redis`](../redis/) — the adapters the API is constructed with.

---

## Status

🚧 Pre-alpha. Routes, config keys and payloads can still change between versions; breaking changes land without deprecation shims.

---

## License

MPL-2.0
