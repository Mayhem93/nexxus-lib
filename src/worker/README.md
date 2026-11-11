# @mayhem93/nexxus-worker-lib

> The Nexxus workers as a library: the Writer, the Transport Manager and the websockets transport, plus the base classes they're built on.

---

## Overview

Each worker is its own process. It connects to the deployment's database, message queue and Redis, consumes one queue, and serves every application stored in the database.

The ready-to-run workers are [nexxus-worker-writer](https://github.com/Mayhem93/nexxus-worker-writer), [nexxus-worker-transport-manager](https://github.com/Mayhem93/nexxus-worker-transport-manager) and [nexxus-worker-websockets-transport](https://github.com/Mayhem93/nexxus-worker-websockets-transport) (Docker images `razvanbotea/nexxus-worker-*`), built on this package.

How a change travels:

1. The API publishes each model write to the `writer` queue. Transient models skip the Writer and go to `transport-manager` directly.
2. The **Writer** applies the write to the database and publishes the change to `transport-manager`.
3. The **Transport Manager** finds every connection subscribed to the change, and publishes a `device_message` to each connection's transport queue.
4. The **transport** delivers it — the websockets transport over the connection's open socket.

A device can hold several connections at once, one per socket: two browser tabs are two connections of one device. Each subscribes on its own. How many it can hold is its application's `connections.maxPerDevice`, 20 by default.

On logout, the API tears down every connection of the device, then publishes `device_logout` to each transport queue it had a connection on, and each transport closes those connections.

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

A worker that can't go on emits `error` with a `FatalErrorException` and stops consuming for good; without an `error` listener, the process exits. A websockets transport does when it can't get its slot back after the message queue reconnects.

A message whose processing fails is retried or dead-lettered:

- **Invalid data, an application or model type the worker doesn't know, or an event it doesn't handle** — dead-lettered at once.
- **Any other failure** — retried after 1 s, 2 s and 4 s, then dead-lettered.
- **A failure while a service is down** — held until the service is back, then retried. It doesn't count as a retry.

When the broker doesn't confirm a message a worker publishes on to the next stage:

- **Writer** — the message it was processing still succeeds, since its write has already happened and retrying would repeat it. The failure is logged as an error, and the event it carried is lost.
- **Transport Manager** — the event fails, so it's retried and dead-lettered like any other failure. It waits for every fan-out message to be confirmed first. A device may then receive the same event twice.

Messages dead-lettered from `writer` and `transport-manager` land in `writer.dlq` and `transport-manager.dlq`, created by the deployment bootstrap. Each keeps the newest `message_queue.deadLetterMaxLength` messages (100 by default), for `message_queue.deadLetterRetention` seconds (3 days by default); a transport's are dropped. Each one is logged with its queue, event and error. See [`nexxus-message-queue-lib`](../message_queue/README.md#failed-messages).

`close()` deregisters from the Hub, stops the management server, stops consuming and gives the messages being processed up to 10 seconds to finish, then disconnects from the database, message queue and Redis. A message still running after that goes back to its queue.

A websockets transport's `close()`, in order:

1. Stops accepting connections.
2. Stops consuming, giving the messages being processed up to 10 seconds to finish.
3. Closes every connection with code `1012`. Each one is torn down, its subscriptions removed. A connection still open after 3 seconds is cut off.
4. Deletes its slot queue.
5. Deregisters from the Hub, stops the management server, and disconnects from the database, message queue and Redis.

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
| `heartbeatInterval` | no | Websockets transport: seconds between pings to each connection, 5 to 300, default 30. Keep it below the idle timeout of a load balancer in front of the transport. |

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
- **Delete** — removes the record and publishes `model_deleted`. A delete for a record that's already gone publishes nothing.
- On applications with access control, it also keeps the Redis copy of the fields ACL conditions are checked against.

### Transport Manager

For each change, it collects:

- every connection with a subscription to a channel the change falls under, and
- every connection with a filtered subscription whose filter matches the changed record: the new record for a create, its filterable fields after an update, its filterable fields as they were before a delete.

Connections are grouped by transport queue and by the channels they matched, and each group gets one `device_message`, which lists each connection as `{ deviceId, connectionId }`.

A stored filter that no longer compiles against the model's schema — after a field it names was removed, for example — is skipped with a warning; everyone else is still notified.

### Websockets transport

- Each instance consumes its own queue, `websockets-transport_<slot>`. The slot is the lowest number the Hub doesn't list as taken. Without a Hub the slot is 0, and a second instance fails to start.
- A registered connection is recorded in Redis on that queue, which is where the Transport Manager sends its events. It starts with no subscriptions, so a client subscribes again after every reconnect. On disconnect it is torn down, its subscriptions removed; the device's other connections keep theirs.
- A connection recorded on the instance's queue that the instance doesn't hold is dead: an instance that held the slot before crashed with it open. It is torn down the first time the instance meets it — when an event for it arrives, or when its device registers on this instance.
- A registration that takes a device over its application's `connections.maxPerDevice` evicts the device's oldest connections, wherever they are. Each one is torn down, then closed with code `4003`: by this instance when it holds it, otherwise by the instance that does, which gets a `connection_evicted` message on its queue. Push connections, dead ones and those being torn down don't count. Two registrations of a device at the same moment can leave it over the cap until its next registration.
- Messages of 2 KB or more are compressed for clients that support `permessage-deflate`. The server answers pings, and pings every connection every `heartbeatInterval` seconds; a connection that hasn't answered by the next ping is closed.
- When its message-queue connection drops, the instance loses its slot queue with it. It closes every connection with code `1012`, and new ones with `1013`. Once the message queue is back, it declares the slot queue again and takes connections again. If the queue exists by then, another instance has taken the slot, and the worker emits `error`.

---

## Websockets protocol

Every frame is JSON: `{ "event": "<name>", "data": { … } }`.

### Client → server

| `event` | `data` | Reply |
| --- | --- | --- |
| `register` | `{ "token": "<access token>", "previousConnectionId": "<id>" }` | `register` with `{ "success": true, "connectionId": "<id>" }`, or `error` |
| `refresh_access_token` | `{ "token": "<new access token>" }` | `refresh_access_token` with `{ "success": true }`, or `error` |

- **`register`** binds the connection to the device the access token names; the token comes from the API. The reply's `connectionId` names this connection: it goes in the `nxx-connection-id` header of `POST` and `DELETE /subscription`. If it fails, the connection stays open and `register` can be sent again. A second `register` on a registered connection is ignored.
- **`previousConnectionId`** is optional: the `connectionId` of a connection that closed without the client asking, sent with the next `register`. That connection is torn down, with its subscriptions, before the new one opens. Only the device's own connections can be named, and naming one that is gone already does nothing. Naming one whose socket is still open can tear it down without closing the socket: it then gets no events, and the API answers `409` for it.
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
- `model.userId` is the id of the user who owns the record, which isn't necessarily whoever changed it.
- `patches` on `model_updated` are in the format `PUT /model/{id}` takes — the `JsonPatch` schema in the API's `openapi.yaml` describes each `op` — plus one that sets `updatedAt`.
- `model.version` on `model_updated` is the record's version after the update. Apply the patches when it is one more than your copy's version; on a larger gap, read the record again.
- The same event can arrive more than once. A repeated `model_updated` carries the version your copy already has.
- An `error` frame doesn't say which frame it answers.

| `code` | Meaning |
| --- | --- |
| `TOKEN_EXPIRED` | The token sent has expired. Get a new one from `POST /auth/refresh` and send it again. |
| `SESSION_ENDED` | The device's session is over, and refreshing won't help. Start a new session. |
| `INVALID_PARAMETERS` | Malformed frame, or a token that doesn't verify. |
| `DEVICE_NOT_FOUND` | The device the token names no longer exists. |
| `INTERNAL_SERVER_ERROR` | Unexpected server error. |

### Connection lifecycle

- Subscribe over HTTP with `POST /subscription` once the connection is registered, with its `connectionId` in the `nxx-connection-id` header; the API answers `409` for a connection that isn't open.
- When the connection closes, its subscriptions are removed. After reconnecting, register and subscribe again: the new connection has a new `connectionId`. After a close the client didn't ask for, send the old `connectionId` as `previousConnectionId`.
- Nothing is delivered past the access token's expiry: the next event for the connection closes it with code `4002`. Each connection rests on its own access token.

| Close code | Reason | Client |
| --- | --- | --- |
| `4001` | `logged_out` | The session was ended with `POST /auth/logout`, which closes every connection of the device. Don't reconnect with it. |
| `4002` | `token_expired` | Refresh the token, reconnect, and register again. |
| `4003` | `evicted` | The device opened more connections than its application allows, and this was its oldest. Don't reconnect automatically: reconnecting evicts the device's next-oldest connection. |
| `1012` | `service_restart` | The transport instance is shutting down, or has lost its message queue. Reconnect after a short random delay. |
| `1013` | `try_again_later` | The transport instance can't take connections right now. Reconnect later, waiting longer after each attempt. |

---

## Custom workers and transports

The built-in workers are subclasses of the exported base classes.

- **`NexxusBaseWorker`** — set `queueName` and `nodeRole`, a static `schemaPath` for the worker's `app` config, and implement `processMessage(msg)`. `publish(queue, payload)` sends to another queue; `getOwnStats()` adds fields to `/stats`. Nothing built in publishes to a custom queue. `onServiceDown(name)` runs when the database (`db`), message queue (`mq`) or Redis (`redis`) disconnects; `beforeResume()` runs before consuming resumes, once all three are back, and rejecting from it is fatal.
- **`NexxusVolatileTransportWorker`** — for transports that hold open connections. Implement `initTransport()`, `sendToConnection(deviceId, connectionId, data)`, `disconnectDevice(deviceId, reason)` (every connection of the device on this instance), `disconnectConnection(deviceId, connectionId, reason)` (one connection, registered or still registering), `stopAcceptingConnections()`, `disconnectAllDevices(reason)` and `holdsConnection(connectionId)`. `disconnectAllDevices` resolves once every connection has been torn down. `holdsConnection` counts a registering connection as held from before `registerConnection` is called.
  - `authenticateDevice(token)` and `authenticateRefreshedToken(token, deviceId, appId)` check tokens; `authenticateDevice` returns the device's connections and its application's cap too.
  - `registerConnection(deviceId, connectionId)` and `unregisterConnection(deviceId, connectionId)` open and tear down a connection in Redis.
  - `releaseLostConnection(deviceId, connectionId)` tears down the connection a client says it lost.
  - `tearDownDeadConnections(deviceId, connections)` at register, and `tearDownDeadConnection(deviceId, connectionId)` for an event to a connection the instance doesn't hold, tear down dead connections in the background.
  - `evictConnectionsOverCap(registration, connectionId, lostConnectionId)`, once a connection has registered, evicts the device's oldest connections over the cap, in the background. A `connection_evicted` message is handled for you, through `disconnectConnection`.
  - Slot queues come with it.
- **`NexxusPersistentTransportWorker`** — for push services (APNs, FCM, …). All instances share one queue. Implement `initTransport()` and `sendToConnection(deviceId, connectionId, data)`; a push connection's id is its push token. `registerConnection(deviceId, connectionId)` and `unregisterConnection(deviceId, connectionId)` open and tear down one. No push transport ships yet.

`processMessage` or `sendToConnection` handed an event it doesn't handle rejects with `NexxusWorkerUnsupportedEventException`, so the message is dead-lettered at once.

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
