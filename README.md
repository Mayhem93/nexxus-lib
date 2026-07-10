# Nexxus Library

> A pluggable, real-time synchronization backend-as-a-service for building event-driven applications

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0.0-blue.svg)](https://www.typescriptlang.org/)

---

## What is Nexxus?

Nexxus is a self-hosted, real-time synchronization platform. Clients subscribe to channels and receive push notifications whenever the data behind them changes — no polling, no manual cache invalidation. The target use case is any application that benefits from a live data model — anywhere concurrent readers care about writes as they happen.

Every major component — database, message queue, logger, transport — is a pluggable adapter chosen at config time. No adapter is baked in; even the built-in Elasticsearch / RabbitMQ / Winston stack is resolved by class name from the config file, right alongside anything custom you ship in your `node_modules`.

---

## Example use cases

Each of these highlights a different subscription topology Nexxus is built around:

- **Chat and messaging.** Users in a room subscribe to that room's `message` channel; a single write fans out to everyone connected. Typing indicators and read receipts sit on their own transient channels.
- **Fleet and logistics tracking.** A dispatcher subscribes to `vehicle` updates with a filter (e.g. `status = 'in_transit'`) so only relevant changes come through; each vehicle publishes its location without knowing who's listening.
- **Live events — sports, auctions, voting.** Thousands of viewers subscribe to one object (a match, a lot, a poll); one server-side write triggers N pushes. The DB write happens once; the broadcast is the interesting part.
- **Collaborative tools.** User-scoped subscriptions (`assignedTo = <me>`) let each team member see only the notifications they care about — no client-side filtering, no wasted server-side push work.
- **Second-screen and companion apps.** A viewer's phone subscribes to `poll` events tied to a specific episode; a producer-triggered write reaches every companion device within milliseconds.

---

## Architecture

![Nexxus diagram](https://razvanbotea.me/nexxus.svg)

A running Nexxus deployment is a small fleet of processes. Client HTTP requests hit the **API server**; app-model writes are queued (not applied inline) to the **Writer worker**, which persists to the database and emits a change event to the **Transport Manager worker**. The Transport Manager resolves who's subscribed to what — including filtered subscriptions matched against the actual changed data — and routes per-transport notifications to the right **transport worker** (WebSockets today, other transports later), which pushes them out over live client connections.

Alongside the pipeline, the **Hub** acts as a lightweight coordination server: nodes register on boot, de-register on shutdown, and the Hub surfaces the live fleet, package-version drift across nodes, and slot counts that slot-based workers (like the WebSockets transport) use to pick their own slot number. See [`nexxus-hub-api`](https://github.com/Mayhem93/nexxus-hub-api) for the current v1.

---

## Packages in this repo

The `src/` directory is an npm workspace containing six library packages. Each is published separately under the `@mayhem93/` scope on npm and consumed by the runnable processes as regular dependencies.

Each subpackage has its own README under `src/<pkg>/README.md` with more detail on the internals.

- **`@mayhem93/nexxus-core-lib`** ([`src/core`](src/core)) — shared types, config manager, base service, logger, Hub client, JSON-schema plumbing. Every other package depends on this one.
- **`@mayhem93/nexxus-database-lib`** ([`src/database`](src/database)) — DB adapter abstraction plus the built-in Elasticsearch adapter. Extension point for other databases.
- **`@mayhem93/nexxus-message-queue-lib`** ([`src/message_queue`](src/message_queue)) — MQ adapter abstraction plus the built-in RabbitMQ adapter. Extension point for other brokers.
- **`@mayhem93/nexxus-redis`** ([`src/redis`](src/redis)) — Redis client wrapper backing subscription and device state. Not currently pluggable — Redis is the only supported store for that data.
- **`@mayhem93/nexxus-api-lib`** ([`src/api`](src/api)) — API framework: routes, middleware, auth strategies, request/response types, model-write queueing.
- **`@mayhem93/nexxus-worker-lib`** ([`src/worker`](src/worker)) — worker framework: base worker, Writer, Transport Manager, WebSockets transport.

---

## Nexxus ecosystem

This repo is the framework you `import`. The runnable processes and the client SDK live in separate repositories, each with its own README covering install, config, and run instructions.

| Component | GitHub | Docker Hub |
| --- | --- | --- |
| API server | [Mayhem93/nexxus-api](https://github.com/Mayhem93/nexxus-api) | `razvanbotea/nexxus-api` |
| Writer worker | [Mayhem93/nexxus-worker-writer](https://github.com/Mayhem93/nexxus-worker-writer) | `razvanbotea/nexxus-worker-writer` |
| Transport Manager worker | [Mayhem93/nexxus-worker-transport-manager](https://github.com/Mayhem93/nexxus-worker-transport-manager) | `razvanbotea/nexxus-worker-transport-manager` |
| WebSockets transport worker | [Mayhem93/nexxus-worker-websockets-transport](https://github.com/Mayhem93/nexxus-worker-websockets-transport) | `razvanbotea/nexxus-worker-websockets-transport` |
| Hub API | [Mayhem93/nexxus-hub-api](https://github.com/Mayhem93/nexxus-hub-api) | `razvanbotea/nexxus-hub-api` |
| JS/TS SDK | [Mayhem93/nexxus-js-sdk](https://github.com/Mayhem93/nexxus-js-sdk) | — |

---

## Extensibility

Nexxus follows a pluggable-service pattern: the logger, database, and message-queue classes are chosen at config time via string names in the `app.logger` / `app.database` / `app.message_queue` fields. Built-in names (`WinstonNexxusLogger`, `NexxusElasticsearchDb`, `NexxusRabbitMq`) are resolved directly to their shipped class; anything else is treated as an npm-package name and dynamic-imported from the running app's `node_modules`. Custom adapters extend the abstract base class from the matching subpackage (`NexxusBaseLogger`, `NexxusDatabaseAdapter`, `NexxusMessageQueueAdapter`) and must satisfy a runtime prototype check at bootstrap — a clear error surfaces at startup if the resolved class doesn't match the expected shape. The concrete method surface each adapter needs to implement lives in the individual subpackage READMEs.

---

## Status

🚧 **Pre-alpha.** The framework is under active development; APIs, config keys, and message payloads may still shift between versions.

- **Implemented**: the full pipeline — API server, Writer worker, Transport Manager worker, WebSockets transport worker — plus the Elasticsearch DB adapter, RabbitMQ MQ adapter, Redis subscription and device storage, Winston logger, and Hub v1 (in-memory node registry with `register` / `de-register` / `list`).
- **In progress / near-term**: user and application-admin ACLs, additional built-in adapters, and test coverage across the framework.
- **Later**: alternative transports (MQTT, SSE, gRPC), custom-worker orchestration via Hub, additional client SDKs, deployment tooling.

For the client-side story, see [`nexxus-js-sdk`](https://github.com/Mayhem93/nexxus-js-sdk).

---

## License

MPL-2.0.
