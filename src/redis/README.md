# @mayhem93/nexxus-redis

> Redis-backed device and subscription store for Nexxus — the real-time routing index.

---

## Overview

Redis is where Nexxus keeps the state needed to route change events to the right clients in real time: the **devices** that are connected (and how to reach them) and the **subscriptions** that say which device wants which changes. The API writes to this state as clients connect and subscribe; the **Transport Manager** reads it on every model change to decide who gets notified.

Unlike the database and message-queue layers, Redis is **not pluggable** — Nexxus depends on specific Redis data structures (JSON documents, sets, hashes) and on sub-millisecond lookups, so there's a single `NexxusRedis` client rather than an adapter contract. This README describes the objects Nexxus stores, their key layout, and how they fit together.

> **Requires the RedisJSON module.** Devices are stored as native JSON documents (`JSON.SET`/`JSON.GET`/`JSON.ARRAPPEND`, etc.), so the Redis server must have RedisJSON available.

---

## The two things Nexxus stores

| Object | Redis type | Written by | Read by |
| --- | --- | --- | --- |
| **Device** | JSON document | API (on connect/register) | Transport Manager, transports |
| **Subscription** | a reverse index across SET + HASH keys | API (on subscribe/unsubscribe) | Transport Manager |

A device holds the *list of channels it subscribes to*; a subscription holds the *reverse* — the set of devices subscribed to a channel — so the Transport Manager can go from "this model changed" straight to "these devices, on these transports."

All keys are namespaced under the `nxx:` prefix.

---

## Devices

A device is a JSON document at:

```text
nxx:device:{deviceId}
```

Shape (`NexxusDeviceProps`):

```typescript
{
  id: string;
  appId: string;
  name: string;
  userId?: string;
  type: 'volatile' | 'persistent' | 'unknown';
  status?: 'online' | 'offline' | 'unknown';
  transport?: string | null;   // the transport/queue the device is reachable on
  lastSeen?: Date;             // volatile devices only; stored as ISO string
  subscriptions: string[];     // subscription *keys* this device holds (see below)
}
```

**Device types** determine subscription lifetime:

- **`volatile`** — connection-oriented transports (e.g. WebSockets). Subscriptions only exist while the connection is live.
- **`persistent`** — connectionless transports (e.g. Apple Push Notifications). Subscriptions persist until the third-party service confirms removal or the device is deleted.
- **`unknown`** — a device created via the API that hasn't registered with a transport yet; it's classified on first registration.

Once a device is classified by a transport, fields like `type`, `transport`, `status`, and `lastSeen` are **only ever overwritten, never cleared** back to undefined. The `subscriptions` array stores subscription **keys** (strings) — the subscription objects themselves live in the reverse-index keys below.

---

## Subscriptions

A subscription channel is described by:

```typescript
interface NexxusSubscriptionChannel {
  appId: string;
  model: string;
  modelId?: string;   // a specific record…
  userId?: string;    // …or a user scope (the two are mutually exclusive in the key)
  filter?: NexxusFilterQuery;  // optional — only matching changes are delivered
}
```

### The channel key

Each channel has a canonical identity key (this is what's stored in a device's `subscriptions` array):

```text
nxx:subscription:{appId}:{model}[:{modelId}][:user:{userId}][:filter:{filterId}]
```

`modelId` is positional (no marker); `userId` is only appended when there's no `modelId`; a filtered subscription appends `:filter:{filterId}`, where `filterId` is the first 16 hex chars of `sha256(normalized filter query)`.

Examples:

```text
nxx:subscription:myapp:task                         # all tasks in the app
nxx:subscription:myapp:task:task-456                # one specific task
nxx:subscription:myapp:task:user:user-123           # a user's tasks
nxx:subscription:myapp:task:filter:a1b2c3d4e5f60718 # filtered subscription
```

### The reverse-index key families

For efficient routing, the device membership behind each channel is spread across four key families:

| Family | Key | Type | Contents |
| --- | --- | --- | --- |
| **Partition** | `nxx:subscription:{channel}:p{h}` | SET | `deviceId\|transport` members for partition `h` |
| **Partition index** | `nxx:subscription-partitions:{channel}` | SET | which partitions (`0`–`f`) are currently non-empty |
| **Scope registry** | `nxx:subscription-scopes:{appId}:{model}` | HASH | scope descriptor → live subscriber count |
| **Filter registry** | `nxx:subscription-filters:{channel}` | HASH | `filterId` → normalized `FilterQuery` JSON |

**Partitioning.** Devices in a channel are hash-bucketed into **16 partitions** by `sha256(deviceId)[0] % 16` (rendered as a hex suffix `p0`–`pf`). This spreads a hot channel's members across multiple keys instead of one giant set. The **partition index** records which of the 16 buckets actually have members, so a read only touches non-empty partitions.

**Scope registry.** So the Transport Manager doesn't probe channels nobody is listening on, each `(appId, model)` keeps a HASH of *scope descriptors* to subscriber counts. Descriptors are canonical:

```text
*                 → app + model (everyone watching the model)
id:X              → a specific record
user:U            → a user scope
id:X|user:U       → a user's view of a specific record
```

Counts are incremented/decremented as devices subscribe/unsubscribe, and a descriptor is dropped when it hits zero — so the TM can list the *active* scopes for a model and skip the rest.

**Filter registry.** A filtered subscription stores its `FilterQuery` once (keyed by `filterId`) rather than per device. The Transport Manager loads the channel's filters and re-evaluates them against the changed model to decide delivery.

### Device transport strings

Partition sets store members as `deviceId|transport` (`NexxusDeviceTransportString`):

```text
device-123|websockets-transport
```

The transport is embedded so the Transport Manager knows which transport queue to route the notification to — the same device may be reachable over more than one transport.

### Fan-out scopes

When a model changes, the Transport Manager expands the change into the set of channel scopes that could match it — app-wide, the owning user's scope, the specific record, and the user's view of that record — then checks each against the scope registry before loading devices. That expansion is produced by `NexxusRedisSubscription.generateSubscriptionPatterns(...)`.

---

## How it fits together

- **API, on subscribe** — adds the device to the channel's partition set, bumps the scope counter, and stores the filter (if any). On unsubscribe it reverses each step and prunes empty partitions/registries.
- **API, on device connect/register** — creates/updates the device JSON document and classifies it (`volatile`/`persistent`).
- **Transport Manager, on a model change** — expands the change into candidate scopes, keeps only the active ones (scope registry), reads the devices from that channel's non-empty partitions, applies any filters, and routes each `deviceId|transport` to the matching transport queue.

---

## Connection & configuration

`NexxusRedis` is a `NexxusBaseService`. Its config lives under the `redis` key and is backed by a JSON schema — see [`src/schemas/redis.schema.json`](src/schemas/redis.schema.json):

```jsonc
{
  "redis": {
    "host": "localhost",
    "port": 6379,
    "user": "…",        // optional
    "password": "…",    // optional
    "cluster": false     // optional — single-node (false) vs Redis Cluster (true)
  }
}
```

Notable client behavior:

- **RESP3 + client-side caching** — the client negotiates RESP3 and keeps a small local cache (FIFO, ~1000 entries, 5-minute TTL) to shave round trips off hot reads.
- **Cluster or single node** — `cluster: true` switches to a cluster client (with replica reads); otherwise a single-node client.
- **Lifecycle events** — like the other adapters, it emits `connect` / `disconnect` (mapped from the underlying client's `ready` / `error` / `end`), which the API and workers use to gate availability.

The Redis config declares no env-var or CLI specs, so it comes from the config file (or a custom provider) rather than `NXX_`-prefixed vars.

Partition count is a fixed internal constant (16), not a configuration knob.

---

## Key classes

- **`NexxusRedis`** — the connection wrapper (`init`, `getClient`, `close`, `getStats`); the single entry point to the client.
- **`NexxusDevice`** — the device JSON document and its subscription list; create/get/update plus add/remove-subscription helpers.
- **`NexxusRedisSubscription`** — a channel's reverse index; builds the keys, manages partition membership, the scope registry, and the filter registry, and expands fan-out scopes.
- **`NexxusRedisBaseModel`** — the small abstract base both models extend.
- **Exception types** — `RedisConnectionErrorException`, `RedisCommandErrorException`, `RedisKeyNotFoundException`, `RedisDeviceInvalidParamsException`, `RedisDeviceNotConnectedException`.

---

## A note on durability

Redis holds *live routing state*, not the system of record. Volatile-transport subscriptions are inherently ephemeral — they exist only while a connection does — so a Redis restart drops them and clients re-subscribe on reconnect. Enable Redis persistence (RDB/AOF) if you want device/persistent-subscription state to survive restarts.

---

## Status

🚧 Pre-alpha. Structures and key layout are still moving; breaking changes land without deprecation shims.

## License

MPL-2.0
