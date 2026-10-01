# @mayhem93/nexxus-worker-lib

> The Nexxus workers as a library: the Writer, the Transport Manager and the websockets transport, plus the base classes they're built on.

---

## Overview

Each worker is its own process. It connects to the deployment's database, message queue and Redis, consumes one queue, and serves every application stored in the database.

The ready-to-run workers are [nexxus-worker-writer](https://github.com/Mayhem93/nexxus-worker-writer), [nexxus-worker-transport-manager](https://github.com/Mayhem93/nexxus-worker-transport-manager) and [nexxus-worker-websockets-transport](https://github.com/Mayhem93/nexxus-worker-websockets-transport) (Docker images `razvanbotea/nexxus-worker-*`), built on this package.

How a change travels:

1. The API publishes each model write to the `writer` queue. Transient models skip the Writer and go to `transport-manager` directly.
2. The **Writer** applies the write to the database and publishes the change to `transport-manager`.
3. The **Transport Manager** finds every device subscribed to the change, and publishes a `device_message` to each device's transport queue.
4. The **transport** delivers it — the websockets transport over the device's open connection.

On logout, the API publishes `device_logout` to the device's transport queue, and the transport closes the device's connection.

---

## Installation

```bash
npm install @mayhem93/nexxus-worker-lib @mayhem93/nexxus-core-lib @mayhem93/nexxus-database-lib @mayhem93/nexxus-message-queue-lib @mayhem93/nexxus-redis
```

The four packages after the workers are peer dependencies. Requires Node.js 24 or later.

---

## Running a worker

```js
import { NexxusConfigManager } from '@mayhem93/nexxus-core-lib';
import { NexxusRedis } from '@mayhem93/nexxus-redis';
import { NexxusBaseWorker, NexxusWriterWorker } from '@mayhem93/nexxus-worker-lib';

const configManager = new NexxusConfigManager('./nexxus-writer.conf.json');

await configManager.validateServices([ NexxusRedis, NexxusWriterWorker ]);

const config = configManager.getConfig('app');

// Built-in class names resolve directly; anything else is imported as an npm package.
const LoggerClass = await NexxusBaseWorker.resolveFactoryService(configManager, config.logger);
const DbClass     = await NexxusBaseWorker.resolveConstructableService(configManager, config.database);
const MqClass     = await NexxusBaseWorker.resolveConstructableService(configManager, config.message_queue);

// Validates the config sections the resolved classes declare.
await configManager.validateServices();

const logger = await LoggerClass.create({ configManager });
const worker = new NexxusWriterWorker({
  configManager,
  logger,
  database:     new DbClass({ configManager, logger }),
  messageQueue: new MqClass({ configManager, logger }),
  redis:        new NexxusRedis({ configManager, logger }),
});

await worker.init();

process.once('SIGTERM', () => worker.close());
process.once('SIGINT',  () => worker.close());
```

`NexxusTransportManagerWorker` and `NexxusWebsocketsTransportWorker` start the same way.

`init()`, in order:

1. Connects to the database, message queue and Redis, and waits until all three are up.
2. Loads every application, with its ACL roles.
3. A websockets transport picks its slot and creates its queue — see [Websockets transport](#websockets-transport).
4. Starts consuming its queue.
5. Starts the management server on `app.management.port`.
6. Registers with the Hub, when `app.hub` is set.
7. A transport then starts its listener: the websockets transport opens its WebSocket server on `app.port`.

`init()` rejects, and the worker doesn't start, when an ACL role doesn't validate against its application's schema, a user type names a role that doesn't exist, or a websockets transport's slot or port is already taken.

While the database, the message queue or Redis is disconnected, the worker stops consuming. It resumes once all three are connected again.

`close()` deregisters from the Hub, stops the management server and disconnects from the database, message queue and Redis. A websockets transport also deletes its slot queue and closes its WebSocket server.

---

## Configuration

Every worker reads the `app` section of the config file. The `database`, `message_queue`, `redis` and `logger` sections belong to the adapters — see their packages for every key. How the file is found, and layered with environment variables, is described in [`nexxus-core-lib`](../core/README.md#configuration-management).

```jsonc
{
  "app": {
    "port": 7000,
    "logger": "WinstonNexxusLogger",
    "database": "NexxusElasticsearchDb",
    "message_queue": "NexxusRabbitMq",
    "management": { "port": 9004, "token": "<management token>" },
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
| `logger` | yes | Logger class: `WinstonNexxusLogger`, or an npm package name. |
| `database` | yes | Database adapter: `NexxusElasticsearchDb`, or an npm package name. |
| `message_queue` | yes | Message-queue adapter: `NexxusRabbitMq`, or an npm package name. |
| `management.port`, `management.token` | yes | Port and bearer token of the management server. |
| `hub.endpoint`, `hub.token` | no | Hub to register with. Without it the worker runs standalone. |
| `port` | websockets transport only | Port of the WebSocket server. |

No worker reads environment variables of its own.

---

## Built-in workers

| Worker | Consumes | Hub role | Instances |
| --- | --- | --- | --- |
| `NexxusWriterWorker` | `writer` | `writer` | Any number, sharing the queue. |
| `NexxusTransportManagerWorker` | `transport-manager` | `transport-manager` | Any number, sharing the queue. |
| `NexxusWebsocketsTransportWorker` | `websockets-transport_<slot>` | `websockets-transport` | Any number, one queue each. |

### Writer

- **Create** — validates the record against the model's schema, stores it, and publishes `model_created`.
- **Update** — validates each patch, adds one that sets `updatedAt`, and applies them. It publishes `model_updated` with the record's filterable fields as they are after the update. An update for a record that doesn't exist is dropped, with a warning.
- **Delete** — removes the record and publishes `model_deleted`.
- On applications with access control, it also keeps the Redis copy of the fields ACL conditions are checked against.

### Transport Manager

For each change, it collects:

- every device with a subscription to a channel the change falls under, and
- every device with a filtered subscription whose filter matches the changed record: the new record for a create, its filterable fields after an update, its identity fields for a delete.

Devices are grouped by transport queue and by the channels they matched, and each group gets one `device_message`.

### Websockets transport

- Each instance consumes its own queue, `websockets-transport_<slot>`. The slot is the lowest number the Hub doesn't list as taken. Without a Hub the slot is 0, and a second instance fails to start.
- A connected device is recorded in Redis as online on that queue, which is where the Transport Manager sends its events. On disconnect it is marked offline.
- Messages of 2 KB or more are compressed for clients that support `permessage-deflate`. The server answers pings and sends none.

---

## Websockets protocol

Every frame is JSON: `{ "event": "<name>", "data": { … } }`.

### Client → server

| `event` | `data` | Reply |
| --- | --- | --- |
| `register` | `{ "token": "<access token>" }` | `register` with `{ "success": true }`, or `error` |
| `refresh_access_token` | `{ "token": "<new access token>" }` | `refresh_access_token` with `{ "success": true }`, or `error` |

- **`register`** binds the connection to the device the access token names; the token comes from the API. If it fails, the connection stays open and `register` can be sent again. A second `register` on a registered connection is ignored.
- **`refresh_access_token`** moves a registered connection onto a new access token from `POST /auth/refresh`, without reconnecting. Send it before the current token expires. The new token must name the same device and application.
- Any other `event` is ignored, without a reply.

### Server → client

| `event` | `data` |
| --- | --- |
| `model_created` | `{ "event", "model": { …the record }, "metadata": { "channels" } }` |
| `model_updated` | `{ "event", "model": { "id", "type", "appId", "userId", "version" }, "patches": [ { "op", "path", "value" } ], "metadata": { "channels" } }` |
| `model_deleted` | `{ "event", "model": { "id", "type", "appId", "userId" }, "metadata": { "channels" } }` |
| `error` | `{ "message", "code" }` |

- `metadata.channels` lists the channel ids, as returned by `POST /subscription`, that the event matched.
- `model.version` on `model_updated` is the record's version after the update. Apply the patches when it is one more than your copy's version; on a larger gap, read the record again.
- An `error` frame doesn't say which frame it answers.

| `code` | Meaning |
| --- | --- |
| `TOKEN_EXPIRED` | The token sent has expired. Get a new one from `POST /auth/refresh` and send it again. |
| `SESSION_ENDED` | The device's session is over, and refreshing won't help. Start a new session. |
| `INVALID_PARAMETERS` | Malformed frame, or a token that doesn't verify. |
| `DEVICE_NOT_FOUND` | The device the token names no longer exists. |
| `INTERNAL_SERVER_ERROR` | Unexpected server error. |

### Connection lifecycle

- Subscribe over HTTP with `POST /subscription` once the connection is registered; the API answers `409` for a device that isn't connected.
- When the connection closes, the device's subscriptions are removed. After reconnecting, register and subscribe again.
- Nothing is delivered past the access token's expiry: the next event closes the connection with code `4002`.

| Close code | Reason | Client |
| --- | --- | --- |
| `4001` | `logged_out` | The session was ended with `POST /auth/logout`. Don't reconnect with it. |
| `4002` | `token_expired` | Refresh the token, reconnect, and register again. |

---

## Custom workers and transports

The built-in workers are subclasses of the exported base classes.

- **`NexxusBaseWorker`** — set `queueName` and `nodeRole`, a static `schemaPath` for the worker's `app` config, and implement `processMessage(msg)`. `publish(queue, payload)` sends to another queue; `getOwnStats()` adds fields to `/stats`. Nothing built in publishes to a custom queue.
- **`NexxusVolatileTransportWorker`** — for transports that hold a connection per device. Implement `initTransport()`, `sendToDevice(deviceId, data)` and `disconnectDevice(deviceId, reason)`. `authenticateDevice(token)`, `authenticateRefreshedToken(token, deviceId, appId)`, `registerDevice(deviceId)` and `unregisterDevice(deviceId)` cover token checks and the device's Redis state. Slot queues come with it.
- **`NexxusPersistentTransportWorker`** — for push services (APNs, FCM, …). All instances share one queue. Implement `initTransport()` and `sendToDevice(deviceId, data)`. No push transport ships yet.

---

## Management server and Hub

The management server answers `GET /stats` on `app.management.port`, with `Authorization: Bearer <app.management.token>`; a missing or wrong token gets `401`.

```json
{ "uptime": 812.4, "queueName": "websockets-transport_0", "loadedApps": 3, "initialized": true, "logger": { },
  "registeredClients": 120, "unregisteredClients": 2, "totalConnections": 122 }
```

The last three fields are the websockets transport's.

With `app.hub` set, a worker registers with the Hub under its role — a websockets transport with its slot too — retrying until the Hub answers, and deregisters on `close()`. An unreachable Hub doesn't stop the worker.

---

## Known limitations

- Applications and their ACL roles are read once, at startup. Restart every worker after creating or changing an application or a role; until then, the websockets transport refuses tokens of a new application.
- With the built-in Elasticsearch adapter, only the first 100 applications are loaded.
- A delete carries only the record's identity fields, so a filtered subscription whose filter tests any other field isn't told about it.

---

## Related packages

- [`@mayhem93/nexxus-api-lib`](../api/) — the API that publishes model writes and issues the tokens transports accept.
- [`@mayhem93/nexxus-core-lib`](../core/) — models, FilterQuery, JsonPatch, queue payload types, configuration, logging.
- [`@mayhem93/nexxus-database-lib`](../database/), [`@mayhem93/nexxus-message-queue-lib`](../message_queue/), [`@mayhem93/nexxus-redis`](../redis/) — the adapters workers are constructed with.

---

## Status

🚧 Pre-alpha. Queue payloads, the websockets protocol and config keys can still change between versions; breaking changes land without deprecation shims.

---

## License

MPL-2.0
