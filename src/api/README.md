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
| `maxBodySize` | no | Largest request body in bytes, 65536–1048576. Default `65536`. |
| `trustProxy` | no | How many proxies in front of the API add the client's address to `X-Forwarded-For`, 0–10. Default `0`: the client's address is the connection's. See [Behind a load balancer](#behind-a-load-balancer). |
| `cors.origins` | no | Origins whose web pages may call the API from a browser: exact origins, or `*` for any. Default: none. See [Browsers (CORS)](#browsers-cors). |
| `rateLimit.enabled` | no | `true` turns on [rate limits](#rate-limits) for every application that doesn't set its own `rateLimit.enabled`. Default `false`. |
| `rateLimit.factor` | no | Multiplies every route's base limit, 1–100, for every application that doesn't set its own. Default `1`. |
| `auth.availableStrategies` | no | Strategies this deployment offers: `local`, `google`, or npm package names. Applications can only enable strategies listed here. |
| `management.port`, `management.token` | yes | Port and bearer token of the management server. |
| `hub.endpoint`, `hub.token` | no | Hub to register with. Without it the API runs standalone. |

Three keys can be set from the environment: `NXX_API_PORT`, `NXX_API_MANAGEMENT_PORT` and `NXX_API_MANAGEMENT_TOKEN`.

With `NODE_ENV=dev`, error responses include the stack trace.

### Per-application settings

These live on each application's document (see [`nexxus-core-lib`](../core/README.md#application)). They are read at startup.

| Field | Meaning |
| --- | --- |
| `signingSecret` | Signs the application's tokens. |
| `session.jwtExpiresIn` | Access-token lifetime in seconds, 600–7200. Default `3600`. |
| `session.refreshTokenExpiresIn` | Session lifetime in seconds, 86400–31536000. Default 30 days. |
| `connections.maxPerDevice` | How many connections a device can hold at once, 1–100. Default `20`. Registering one more closes the device's oldest — see [`nexxus-worker-lib`](../worker/README.md#websockets-transport). |
| `rateLimit.enabled` | `true` or `false` turns [rate limits](#rate-limits) on or off for this application, whatever `app.rateLimit.enabled` says. Unset, the deployment's value applies. |
| `rateLimit.factor` | Multiplies every route's base limit for this application, 1–100. Unset, the deployment's value applies. |
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
| `POST` | `/user/register` | Creates an account with a username and password, and signs it in. With a username that exists and its password, signs in to that account. |
| `GET` | `/user/me` | The signed-in user. |
| `PUT` | `/user` | Updates the signed-in user. The username can't be changed, and a password can only be replaced. |
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
| `POST` | `/subscription` | Subscribes one connection of the calling device, named in `nxx-connection-id`, to a channel. Returns the first page of data and the channel id. |
| `DELETE` | `/subscription` | Unsubscribes one connection of the calling device, named in `nxx-connection-id`, from a channel. |

`POST /auth/{strategy}` exists for every strategy in `app.auth.availableStrategies`, and the callback for those that use one (`google`). An application that doesn't enable the strategy gets `404`.

---

## Requests and errors

- Every route except `GET /` and `GET /auth/{strategy}/callback` requires the `nxx-app-id` header. It is not a secret.
- `/subscription` also requires `nxx-connection-id`: the `connectionId` the transport answered `register` with. It must name an open connection of the token's device, or the request gets `409 DeviceNotConnectedException`.
- Tokens go in `Authorization: Bearer <token>`. On an application with authentication, every route needs one except `GET /`, `/user/register` and the `/auth/*` routes. On an application without authentication, only `/device` and `/subscription` need one — the token from `/device/register`.
- Dates are UNIX timestamps in seconds.

Every error has the same body, with the HTTP status set to match:

```json
{ "error": "AccessDeniedException", "message": "Access denied" }
```

A body larger than `app.maxBodySize` is answered `413 PayloadTooLargeException`, and a body that isn't valid JSON `400 InvalidParametersException`.

With rate limits on, a request over its route's limit is answered `429 TooManyRequestsException` — see [Rate limits](#rate-limits).

While the database, the message queue or Redis is disconnected, every request is answered `503 ServiceUnavailableException`. Requests are served again as soon as it reconnects.

A request the database fails is answered `500 ServerErrorException` with a generic message; the database's own error is only logged.

A model write the message queue doesn't confirm is answered `503 ServiceUnavailableException` instead of `202`.

Each request is logged at `info` when it completes, with its method, URL, status and duration. Errors with a `5xx` status are logged at `error`, others at `info`.

---

## Rate limits

Off unless `app.rateLimit.enabled` or the application's own `rateLimit.enabled` is `true`. Each route below then allows a number of requests a minute: its base, times the factor (`rateLimit.factor`), rounded up.

| Route | Base per minute |
| --- | --- |
| `POST /auth/{strategy}`, `POST /auth/logout`, `POST /user/register`, `POST /device/register`, `PUT /device` | 5 |
| `GET /device`, `GET /device/list` | 10 |
| `POST /auth/refresh` | 20 |
| `GET /user/me`, `PUT /user`, `POST /model`, `DELETE /model/{id}`, `POST /subscription`, `DELETE /subscription` | 60 |
| `POST /model/{type}/search`, `PUT /model/{id}` | 90 |
| `POST /model/count` | 120 |
| `GET /model/{id}` | 240 |

- A request counts against its user; on an application without authentication, against its device; with no token, against its IP address. `POST /device/register` counts against the user, or the IP address without one.
- The IP address is the connection's, or the one a load balancer passes on — see [Behind a load balancer](#behind-a-load-balancer).
- IPv6 addresses count per /56 network.
- Each application and each route counts separately. A count runs for one minute from its first request, then starts over.
- A request turned away before its route runs — no `nxx-app-id`, an unknown application, an invalid token — isn't counted.
- A request over the limit is not carried out. It is answered `429 TooManyRequestsException`, with `Retry-After` in seconds.
- Every counted response carries `RateLimit` and `RateLimit-Policy` (IETF draft 8).
- `GET /`, `GET /auth/{strategy}/callback` and unknown paths are never limited.
- Each API instance keeps its own counts, in memory, and a restart starts them over. Behind a load balancer, use sticky sessions, or a client gets the limit from every instance.

---

## Behind a load balancer

Rate limits count requests without a token per client IP address. Behind a load balancer, the API only knows that address if `app.trustProxy` tells it where to find it:

- `0`, the default: the address the connection comes from. `X-Forwarded-For` is ignored.
- `N`: the Nth address from the right end of `X-Forwarded-For`. Each proxy appends the address the request reached it from, so `N` is the number of proxies between the client and the API that do.

An address written with a port, such as `203.0.113.7:4711` or `[2001:db8::7]:4711`, counts without it.

When `trustProxy` is wrong:

- **Too low**, such as `0` behind an AWS ALB: every request seems to come from the load balancer. All clients without a token share one count, and one busy client gets everyone else refused.
- **Too high**: the API takes an address the client wrote into its own `X-Forwarded-For`. A client can name a new address with every request, and is never limited.

With `trustProxy` above `0`, the API must be reachable only through those proxies. A client that connects to it directly can send any `X-Forwarded-For`.

| In front of the API | The client's address arrives in | `trustProxy` |
| --- | --- | --- |
| Nothing, or a router's port forward | the connection | `0` |
| AWS NLB with client IP preservation | the connection | `0` |
| nginx or HAProxy as a transparent proxy | the connection | `0` |
| AWS ALB | `X-Forwarded-For` | `1` |
| nginx | `X-Forwarded-For` | `1` |
| HAProxy | `X-Forwarded-For` | `1` |
| Amazon CloudFront, then an AWS ALB | `X-Forwarded-For` | `2` |

**AWS ALB.** Keep the load balancer's X-Forwarded-For header setting (`routing.http.xff_header_processing.mode`) at `append`, the default. `preserve` passes the client's own header on unchanged, and `remove` drops it.

**AWS NLB.** The client's address arrives in the connection only with client IP preservation (`preserve_client_ip.enabled` on the target group). It is on by default for instance targets, and off for IP targets with TCP or TLS. An IPv6 client reaching an IPv4 target, or the reverse, still arrives from the load balancer's address.

**nginx.**

```nginx
location / {
  proxy_pass http://nexxus_api;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

As a transparent proxy, with `proxy_bind $remote_addr transparent;`, nginx connects to the API from the client's address instead, and `trustProxy` is `0`. It needs kernel routing set up on the nginx host, and the API servers' replies must route back through it.

**HAProxy.**

```haproxy
backend nexxus_api
  mode http
  option forwardfor
  server api1 10.0.1.10:5000 check
```

Leave out `if-none`: with it, HAProxy passes on a header the client sent and adds nothing.

As a transparent proxy, with `source 0.0.0.0 usesrc clientip`, HAProxy connects to the API from the client's address instead, and `trustProxy` is `0`. It needs kernel routing set up on the HAProxy host, and the API servers must use it as their default gateway.

**Not supported: the PROXY protocol** — HAProxy `send-proxy`, nginx `proxy_protocol`, AWS NLB proxy protocol v2. The API can't read it, and every request fails.

**Docker.** On Linux, published ports keep the client's address. Docker Desktop doesn't, and neither does Docker's userland proxy, which handles, for one, IPv6 clients of a container network without IPv6. Behind either, every request comes from the proxy's address.

**Checking the setup.** Turn rate limits on and send a request without a token, such as `POST /auth/logout`, from two different networks. The `pk` values in their `RateLimit-Policy` headers differ when the API sees two addresses.

---

## Browsers (CORS)

A web page served from another origin than the API's — another scheme, host or port — can call the API only if `app.cors.origins` lists its origin. Only browsers apply this: servers, scripts and mobile apps are never affected.

```jsonc
"cors": { "origins": [ "https://demo.example.com", "http://localhost:5173" ] }
```

- Each entry is an exact origin: scheme, host and port, without a path or a trailing slash. `"*"` allows every origin. By default, none is listed.
- Before each API request, a browser sends an `OPTIONS` preflight to the same URL. A listed origin's preflight is answered `204`, and the browser then sends the request. Any other origin's is answered `403 OriginNotAllowedException`, the browser fails the request with a CORS error, and the API logs the origin it refused.
- Pages can send `Authorization`, `Content-Type`, `nxx-app-id` and `nxx-connection-id`, with `GET`, `POST`, `PUT` and `DELETE`. The browser refuses a request with any other header.
- Responses to a listed origin, errors included, can be read by the page, and so can their `Retry-After`, `RateLimit` and `RateLimit-Policy` headers.
- A browser reuses a preflight's answer for the same URL for up to 2 hours, so `GET /model/{id}` costs one preflight for every new `{id}`. A page served from the API's own origin sends none.

**Local testing.**

- `http://localhost:5173`, `http://localhost:3000` and `http://127.0.0.1:5173` are three different origins. List the one the dev server runs on, or use `"*"` in a development deployment.
- Or let the dev server forward API calls, with Vite's `server.proxy` or Next.js rewrites. The page and the API then share one origin, and CORS doesn't apply.
- Chrome asks the user for permission before a page served from a public origin calls a private-network or `localhost` address.

---

## Sessions and devices

`/user/register`, `/auth/{strategy}` and `/device/register` return a session: a `token`, a `refreshToken`, and the `device` both are bound to.

- **`token`** is the access token, sent as `Authorization: Bearer <token>`. It names the device, and also the user on an application with authentication. It lasts the application's `session.jwtExpiresIn` (default 1 hour); after that, requests get `401 UserTokenExpiredException`.
- **`refreshToken`** goes to `POST /auth/refresh`, which returns a new `token` and `refreshToken`. The session ends `session.refreshTokenExpiresIn` after it started (default 30 days), however often it is refreshed. After that, `/auth/refresh` answers `401 InvalidRefreshTokenException`, and the user signs in again.
- **`accountCreated`** is `true` when the request created the account — a new registration, or a first sign-in through an OAuth provider — and `false` for any other sign-in. `/device/register` doesn't send it.
- A refresh token works once. The one it replaced is still accepted for 10 seconds, so a retried refresh succeeds; presented any later, it ends the session.
- `POST /auth/logout` ends the session, tears down every connection of the device with its subscriptions, and closes the live ones. It answers `200` whether or not the refresh token was valid.
- Applications without authentication refresh and log out the same way.

Which device a session is bound to:

- `/user/register` always creates a device, including when it signs in to an existing account. So does a first sign-in through an OAuth provider.
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

One account per username: two registrations, or a registration and a first sign-in through an OAuth provider, for the same username at the same moment end with a single account, which the second request finds. A request still waiting after a few seconds is answered `503 ServiceUnavailableException`.

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
- To finish a sign-in, call `sendSessionForNewUser(res, user)` when it created the account, and `sendSessionForExistingUser(res, user, deviceHint)` otherwise; the response's `accountCreated` is `true` or `false` to match. `findOrCreateUser()` returns the user, and whether it was just created.
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
