# Nexxus Library

> A pluggable, real-time synchronization backend-as-a-service for building event-driven applications

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue.svg)](https://www.typescriptlang.org/)

---

## 📋 Table of Contents

- [What is Nexxus?](#-what-is-nexxus)
- [Why Nexxus?](#-why-nexxus)
- [Architecture Overview](#%EF%B8%8F-architecture-overview)
- [Package Structure](#-package-structure)
- [Key Concepts](#-key-concepts)
- [Use Cases](#-use-cases)
- [Extensibility](#-extensibility)
- [Project Status](#-project-status)
- [Getting Started](#-getting-started)

---

## 🎯 What is Nexxus?

**Nexxus** is a self-hosted, real-time synchronization platform designed for building event-driven applications. At its core, Nexxus enables clients to subscribe to channels and receive instant notifications about data changes—whether it's object creation, updates, or deletion.

Unlike traditional REST APIs where clients poll for updates, Nexxus pushes changes in real-time, making it ideal for:

- Chat applications
- Live event dashboards
- Second-screen experiences
- Fleet management systems
- Collaborative tools
- IoT device monitoring

### Core Philosophy

**Flexibility through plugins.** Nexxus is built on the principle that no single technology stack fits all use cases. Want PostgreSQL instead of Elasticsearch? Kafka instead of RabbitMQ? MQTT instead of WebSockets? Just plug in your adapter.

---

## 💡 Why Nexxus?

### 🔌 Truly Pluggable Architecture

Every major component is **replaceable**:

| Component | Built-in | Pluggable Alternative Examples |
|-----------|----------|-------------------------------|
| **Database** | Elasticsearch | PostgreSQL, MongoDB, Neo4j, CouchDB |
| **Message Broker** | RabbitMQ | Kafka, Redis Streams, AWS SQS |
| **Transports** | WebSockets | MQTT, SSE, gRPC, Socket.IO |
| **Logger** | Winston | Rollbar, Datadog, custom loggers |
| **Config Provider** | File/Env/CLI | AWS Secrets Manager, Vault, etcd |
| **Workers** | Writer, Transport Manager, Transport (hardcoded with websockets at the moment) | Custom business logic workers |

### 🚀 Real-Time by Design

Built from the ground up for **real-time synchronization**:

- Instant push notifications to connected clients
- Filtered subscriptions (only get updates you care about)
- Multi-tenant isolation (applications don't interfere with each other)
- Device-aware (same user, different devices)

### 🛠️ Developer-Friendly

- **TypeScript-first** with full type safety
- **Custom DSLs** for filtering (FilterQuery) and updates (JsonPatch)
- **Worker pipeline** for custom processing logic
- **Self-hosted** - deploy anywhere (cloud, on-premise, containers)

---

## 🏗️ Architecture Overview

Nexxus follows a **distributed worker architecture** where different services handle specific responsibilities:

![Nexxus diagram](https://razvanbotea.me/nexxus.svg)

### Data Flow Example

**Scenario:** User creates a new task in a task management app

1. **Client** → Sends POST request to API: `POST /model/task`
2. **API** → Validates request, publishes to Writer Queue
3. **Writer Worker** → Persists task to Database (Elasticsearch)
4. **Writer Worker** → Publishes `model_created` event to Transport Manager Queue
5. **Transport Manager** → Queries Redis for devices subscribed to `app:myapp:model:task`
6. **Transport Manager** → Filters subscriptions (e.g., only tasks with `priority=high`)
7. **Transport Manager** → Routes notification to the right transport worker
8. **Transport Worker** → Pushes real-time update to connected clients
9. **Client** → Receives notification and updates UI

At the moment pluggable (custom) workers are not supported but the way they would work is:

- Through another piece of software called Nexxus Hub (not yet implemented) we design how the whole process looks
- The hub is responsible for holding information about the nodes including information about the data flow in the pipeline
- We may have "sync" workers that can be added before the write worker (so API would send it to this worker instead), afterwards it will forward the message to the write worker
- "Async" workers these do not require to have an "output" eg: they don't pass the message to another worker

### About database models

These come in two flavors (they share a common base):

- Nexxus builtins like for example Application, User, Admin etc
- Nexxus application models which are application bound, the name of a model cannot be a reserved nexxus builtin name
- They share a common base like "id", "createdAt" and "updatedAt"

---

## 📦 Package Structure

This is a **monorepo** containing multiple interconnected packages:

### `@nexxus/core`

**Foundation layer** - Shared types, models, and utilities used across all packages.

- **Models**: `Application`, `User`, `AppModel` (base classes with validation)
- **DSLs**: `FilterQuery` (database-agnostic querying), `JsonPatch` (custom JSONPatch)
- **Services**: `ConfigManager`, `Logger`, `BaseService` (both implementations and abstract classes)
- **Types**: Queue payloads, model schemas, common interfaces

**Key Files:**

- `models/` - Built-in and app model classes
- `common/FilterQuery.ts` - Query DSL for filtering
- `common/JsonPatch.ts` - Custom patch operations
- `common/QueuePayloads.ts` - Message queue event types

---

### `@nexxus/database`

**Database abstraction layer** - CRUD operations with pluggable adapters.

- **Built-in Adapter**: Elasticsearch (full-text search, scalable)
- **Interface**: `DatabaseAdapter` (extend for other databases)
- **Operations**: `createItem`, `updateItem`, `deleteItem`, `searchItems`, `getItems`
- **Query Translation**: Converts `FilterQuery` to native database queries

**Example Custom Adapter:**

```typescript
class PostgresDatabaseAdapter extends DatabaseAdapter {
  // Implement abstract methods for PostgreSQL
}
```

**Dependencies:**

- `@elastic/elasticsearch` (built-in adapter)
- `@nexxus/core` (models, FilterQuery)

---

### `@nexxus/message_queue`

**Message broker abstraction** - Event-driven communication between services.

- **Built-in Adapter**: RabbitMQ (reliable message delivery)
- **Interface**: `MessageQueueAdapter` (extend for Kafka, SQS, etc.)
- **Patterns**: Topic-based (broadcast) and Queue-based (point-to-point)
- **Payload Types**: Defined in `@nexxus/core/QueuePayloads.ts`

**Message Flow:**

- API → Writer Queue → Writer Worker
- Writer Worker → Transport Manager Queue → Transport Manager Worker
- Transport Manager → WebSocket Queue → WebSocket Worker

**Dependencies:**

- `amqplib` (RabbitMQ client)
- `@nexxus/core` (payload types)

---

### `@nexxus/redis`

**Subscription & device storage** - Fast lookups for real-time routing.

- **Purpose**: Store active subscriptions and connected devices
- **Modes**: Single-node (development) and Cluster (production)
- **Partitioning**: Subscriptions are partitioned for horizontal scaling
- **Models**: `NexxusRedisSubscription`, `NexxusRedisDevice`

**Subscription Key Structure:**

```
nxx:subscription:{subscriptionId}:{modelType}:filter:{filterId}:partition:{partitionId}
```

**Not Pluggable:** Redis is the only supported storage for subscriptions/devices.

**Dependencies:**

- `redis` (official Redis client)
- `@nexxus/core` (subscription models)

---

### `@nexxus/api`

**REST API server** - Main entry point for clients.

**Features:**

- **Authentication**: Local (username/password), OAuth (Google), optional auth mode
- **Routes**:
  - `/user/*` - User registration, login, profile management
  - `/device/*` - Device registration and information
  - `/subscription/*` - Subscribe/unsubscribe to channels
  - `/model/:type` - CRUD operations on app models (queued, not direct DB writes)
- **Middleware**: Authentication, request validation, error handling
- **Authorization**: JWT-based with device-specific tokens

**Important:** App model writes (create/update/delete) are **queued** to Writer Worker, not written directly to the database. User management endpoints write directly.

**Dependencies:**

- `express` (HTTP server)
- `passport` (authentication)
- `jsonwebtoken` (JWT tokens)
- `@nexxus/core`, `@nexxus/database`, `@nexxus/message_queue`, `@nexxus/redis`

---

### `@nexxus/worker`

**Background processing** - Workers that handle async operations.

#### **Writer Worker**

- **Consumes**: `writer` queue (from API)
- **Purpose**: Persist app model CRUD operations to database
- **Publishes**: `transport-manager` queue (notify about changes)
- **Events**: `model_created`, `model_updated`, `model_deleted`

#### **Transport Manager Worker**

- **Consumes**: `transport-manager` queue (from Writer)
- **Purpose**: Determine which devices should receive notifications
- **Logic**:
  1. Query Redis for subscriptions matching the changed model
  2. Filter subscriptions based on `FilterQuery` (if filtered subscriptions exist)
  3. Group devices by transport type (WebSocket, MQTT, etc.)
  4. Publish to transport-specific queues
- **Publishes**: `websockets-transport` queue (or other transports)

#### **WebSocket Worker**

- **Consumes**: `websockets-transport` queue (from Transport Manager)
- **Purpose**: Push real-time updates to connected WebSocket clients
- **Connection Management**: Tracks active connections, removes on disconnect
- **Device-aware**: Multiple connections per user supported

**Future Workers:**

- Custom business logic workers (e.g., email notifications)
- Data transformation workers (e.g., masking sensitive fields)
- Integration workers (e.g., trigger external webhooks)

**Dependencies:**

- `ws` (WebSocket library)
- `@nexxus/core`, `@nexxus/database`, `@nexxus/message_queue`, `@nexxus/redis`

---

## 🔑 Key Concepts

### FilterQuery DSL

A **database-agnostic query language** for filtering data. Supports field validation, type checking, and operator validation based on model schemas.

**Example:**

```typescript
// Filter tasks by priority and status
{
  "$and": [
    { "priority": { "eq": "high" } },
    { "status": { "in": ["todo", "in_progress"] } }
  ]
}
```

**Operators:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `and`, `or`

**Features:**

- Schema validation (field existence, type checking)
- Field-level `filterable` flag for fields that accept filtering
- Nested object support (dot notation: `user.details.age`)
- Should translate to native database queries (Elasticsearch, SQL, etc.)

---

### Custom JsonPatch

A **custom implementation** of JSON Patch for update operations (not RFC 6902 compliant).

**Differences from Standard:**

- Uses `.` instead of `/` for path delimiters
- Supports multiple paths/values in a single patch
- Additional operations beyond standard (e.g., batch updates)

**Example:**

```typescript
{
  "op": "replace",
  "path": ["status", "priority"],
  "value": ["completed", "low"]
}
```

**Use Cases:**

- Efficient partial updates (only changed fields)
- Real-time synchronization (send minimal data over WebSocket)
- Atomic operations (all-or-nothing updates)

---

### Subscriptions

Clients **subscribe to channels** to receive real-time updates.

**Channel Structure:**

```typescript
{
  appId: string;        // Application ID (multi-tenancy)
  userId?: string;      // Optional: user-specific data
  model: string;        // Model type (e.g., "task", "message")
  modelId?: string;     // Optional: specific object ID
  filter?: FilterQuery; // Optional: filtered subscription
}
```

**Examples:**

**Unfiltered Subscription** (all tasks):

```typescript
{
  appId: "myapp",
  model: "task"
}
```

**Filtered Subscription** (only high-priority tasks):

```typescript
{
  appId: "myapp",
  model: "task",
  filter: { "priority": { "eq": "high" } }
}
```

**User-specific Subscription** (my tasks only):

```typescript
{
  appId: "myapp",
  userId: "user123",
  model: "task"
}
```

**Object-specific Subscription** (single task):

```typescript
{
  appId: "myapp",
  model: "task",
  modelId: "task-456"
}
```

---

### Transports

**Connection-based delivery mechanisms** for pushing updates to clients.

**Built-in:** WebSockets (volatile, connection-based)

**Future Transports:**

- MQTT (IoT devices)
- Server-Sent Events (one-way streaming)
- gRPC (high-performance)
- Socket.IO (fallback support)
- Apple/Google push notifications (not `volatile` but `persistent`)

**Transport Characteristics:**

- **Volatile**: Subscriptions removed on disconnect (WebSocket, MQTT)
- **Persistent**: Subscriptions survive disconnects (future: push notifications)

---

## 🎯 Use Cases

### 1. Chat Application

**Scenario:** Real-time messaging with typing indicators

- Users subscribe to: `{ appId: "chat", model: "message", roomId: "room-123" }`
- New message → Writer → Transport Manager → WebSocket → All subscribed users
- Typing indicators via separate channel

### 2. Fleet Management System

**Scenario:** Track delivery vehicles in real-time

- Dispatcher subscribes to: `{ appId: "logistics", model: "vehicle" }`
- Vehicle updates location → GPS device sends update → API → Real-time dashboard
- Filtered subscription: `{ "status": { "eq": "in_transit" } }` (only moving vehicles)

### 3. Live Event Dashboard

**Scenario:** Sports scoreboard with thousands of viewers

- Viewers subscribe to: `{ appId: "sports", model: "match", modelId: "match-789" }`
- Score update → Single write → Broadcast to all subscribers
- Efficient: One database write, N WebSocket pushes

### 4. Collaborative Task Management

**Scenario:** Team members see updates instantly

- User-specific: `{ appId: "taskapp", userId: "user123", model: "task" }`
- Filtered: `{ model: "task", filter: { "assignedTo": { "$eq": "user123" } } }`
- Task assignment → Notify only affected users

### 5. Second-Screen Experience

**Scenario:** TV show with companion mobile app

- Viewers subscribe to: `{ appId: "tvshow", model: "poll", modelId: "episode-5" }`
- Show triggers poll → Push to all connected devices
- Real-time voting results update automatically

---

## 🔌 Extensibility

### Custom Database Adapter

Want to use **PostgreSQL** instead of Elasticsearch?

```typescript
import { DatabaseAdapter } from '@nexxus/database';

export class PostgresDatabaseAdapter extends DatabaseAdapter {
  private pool: pg.Pool;

  async connect() {
    this.pool = new pg.Pool({ /* config */ });
  }

  async createItem(options: NexxusDbCreateOptions) {
    // Implement PostgreSQL INSERT
  }

  async updateItem(options: NexxusDbUpdateOptions) {
    // Implement PostgreSQL UPDATE with JsonPatch logic
  }

  async searchItems(options: NexxusDbSearchOptions) {
    // Translate FilterQuery to SQL WHERE clause
    const sqlQuery = this.buildQuery(options.filters);
    // Execute query
  }

  private buildQuery(filter: NexxusFilterQuery): string {
    // Convert FilterQuery DSL to SQL
  }
}
```

At the moment different adapters are only plugged in via code in the api/worker code itself (this will be a separate project that builds upon the library that we have here).

Idealy in the future we want to specify which adapters to use via the "conf.json" file so in the could it would be opaque which adapter would actually be used, this requires dynamic imports of course. When it comes to provisioning of course there will be an extra steps to install those adapters as npm dependencies

**Register in config:**

```typescript
import { NexxusConfigManager, WinstonNexxusLogger } from '@nexxus/core';
import { NexxusPgSQLDb } from 'nexxus_pgsql';
import { NexxusRabbitMq } from '@nexxus/message_queue';
import { NexxusRedis } from '@nexxus/redis';
import { NexxusWriterWorker } from '@nexxus/worker';

const configManager = new NexxusConfigManager('nexxus-writer.conf.json');

configManager.validateServices([
  WinstonNexxusLogger,
  NexxusPgSQLDb,
  NexxusRabbitMq,
  NexxusRedis,
  NexxusWriterWorker
]);

const logger = new WinstonNexxusLogger({ configManager });
const db = new NexxusPgSQLDb({ configManager, logger});
const mq = new NexxusRabbitMq({ configManager, logger});
const redis = new NexxusRedis({ configManager, logger});
const worker = new NexxusWriterWorker({ configManager, logger, database: db, messageQueue: mq, redis });

(async () => {
  await db.connect();
  await mq.connect();
  await redis.init();
  await worker.init();
})();
```

---

### Custom Worker

Want to **send email notifications** when tasks are assigned?

```typescript
import { NexxusBaseWorker } from '@nexxus/worker';

export class EmailNotificationWorker extends NexxusBaseWorker {
  async handleMessage(payload: NexxusModelUpdatedPayload) {
    if (payload.data.metadata.type === 'task') {
      const patch = new NexxusJsonPatch(payload.data);
      const partial = patch.getPartialModel();

      if (partial.assignedTo) {
        await this.sendEmail(partial.assignedTo, 'New task assigned!');
      }
    }
  }
}
```

**Add to pipeline:**

- API → Writer Queue → Writer Worker
- Writer Worker → **Email Worker Queue** → Email Notification Worker
- Writer Worker → Transport Manager Queue → ...

---

### Custom Config Provider

Want to use **AWS Secrets Manager**?

```typescript
import { BaseConfigProvider } from '@nexxus/core';

export class AWSSecretsConfigProvider extends BaseConfigProvider {
  async getConfig(): NexxusConfig {
    const secretsManager = new AWS.SecretsManager();
    const secret = await secretsManager.getSecretValue({ SecretId: 'nexxus-config' }).promise();
    return JSON.parse(secret.SecretString);
  }
}
```

**Register in ConfigManager: (TODO)**

```typescript
const configManager = new ConfigManager([
  new FileConfigProvider('./config.json'),
  new EnvConfigProvider(),
  new AWSSecretsConfigProvider()
]);
```

---

### Custom Logger

Want to use **Rollbar** for error tracking?

```typescript
import { BaseLogger } from '@nexxus/core';

export class RollbarLogger extends BaseLogger {
  private rollbar: Rollbar;

  async initialize() {
    this.rollbar = new Rollbar({ accessToken: 'YOUR_TOKEN' });
  }

  error(message: string, meta?: any) {
    this.rollbar.error(message, meta);
  }

  // Implement other log levels...
}
```

---

## 🚧 Project Status

**Current Stage:** Pre-Alpha / Active Development

### ✅ Implemented

- Core models and types
- FilterQuery DSL (database-agnostic querying)
- Custom JsonPatch (update operations)
- Elasticsearch database adapter
- RabbitMQ message queue adapter
- Redis subscription/device storage
- REST API (authentication, CRUD, subscriptions)
- Writer Worker (persist app models)
- Transport Manager Worker (route notifications)
- WebSocket Worker (real-time push)

### 🚧 In Progress

- User ACL management
- Application admins (and their ACL as well)
- Plugin architecture finalization
- Abstract classes for transports (MQTT, SSE, etc.)
- Configuration schema and validation
- Comprehensive testing

### 📋 Roadmap (TODO)

- Additional database adapters (PostgreSQL, MongoDB)
- Additional message queue adapters (Kafka, Redis Streams)
- Alternative transports (MQTT, SSE, gRPC)
- Client SDKs (TypeScript, Python, Go)
- Deployment tooling (Docker, Kubernetes)
- Documentation and examples
- Performance benchmarks
- Security audit

**⚠️ Not Production-Ready:** This project is under active development. APIs may change without notice.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** >= 24.0.0
- **TypeScript** >= 5.9.3
- **Elasticsearch** (for built-in database adapter)
- **RabbitMQ** (for built-in message queue adapter)
- **Redis** (for subscriptions and device storage)

### Installation (Conceptual)

```bash
# Clone repository
git clone https://github.com/yourusername/nexxus-lib.git
cd nexxus-lib

# Install dependencies
npm install

# Build all packages
npm run build
```

### Basic Configuration

```typescript
// config.json
{
  "database": {
    "host": "localhost",
    "port": 9200
  },
  "message_queue": {
    "host": "localhost",
    "port": 5672,
    "user": "guest",
    "password": "guest"
  },
  "redis": {
    "host": "localhost",
    "port": 6379,
    "cluster": false,
    "password": "1234test"
  },
  "app": {
    "name": "test"
  },
  "logger": {
    "level": "debug",
    "timestamps": true,
    "logType": "text",
    "colors": false
  }
}

```

### Running Services (Conceptual)

```bash
# Start API server
npm run start:api

# Start Writer Worker
npm run start:worker:writer

# Start Transport Manager Worker
npm run start:worker:transport-manager

# Start WebSocket Worker
npm run start:worker:websocket
```

**Note:** Deployment tooling and CLI are not yet implemented. The above commands are illustrative.

---

## 📚 Documentation

- **API Reference:** (Coming soon)
- **Architecture Deep Dive:** (Coming soon)
- **Plugin Development Guide:** (Coming soon)
- **Client SDK Documentation:** (Coming soon)

---

## 🤝 Contributing

This project is open-source and welcomes contributions! Whether it's:

- Writing database adapters
- Creating transport implementations
- Improving documentation
- Reporting bugs
- Suggesting features

**Contribution guidelines:** (Coming soon)

---

## 📄 License

MPL-2.0 License - See [LICENSE](LICENSE) file for details

---

## 🙏 Acknowledgments

- Built with [Express](https://expressjs.com/), [TypeScript](https://www.typescriptlang.org/), and [Node.js](https://nodejs.org/)
- Inspired by Firebase, Supabase
- Community-driven plugin ecosystem

---

**Questions?** Open an issue or start a discussion!

**Want to contribute?** Check out the [Contributing Guide](#contributing) (coming soon)
