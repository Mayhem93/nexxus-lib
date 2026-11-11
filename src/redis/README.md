# @mayhem93/nexxus-redis

> Redis-backed device and subscription store for Nexxus — the real-time routing index.

---

## Overview

Redis is where Nexxus keeps the state needed to route change events to the right clients in real time: the **devices**, with their open **connections** (and how to reach them), and the **subscriptions** that say which connection wants which changes. The transports and the API write this state as clients connect and subscribe; the **Transport Manager** reads it on every model change to decide who gets notified.

Unlike the database and message-queue layers, Redis is **not pluggable** — Nexxus depends on specific Redis data structures (JSON documents, sets, hashes) and on sub-millisecond lookups, so there's a single `NexxusRedis` client rather than an adapter contract. This README describes the objects Nexxus stores, their key layout, and how they fit together.

> **Requires the RedisJSON module.** Devices are stored as native JSON documents (`JSON.SET`/`JSON.GET`/`JSON.ARRAPPEND`, etc.), so the Redis server must have RedisJSON available.

---

## The two things Nexxus stores

| Object | Redis type | Written by | Read by |
| --- | --- | --- | --- |
| **Device** | JSON document, with its connections | API (sign-in, subscribe, logout), transports (connections) | API, transports |
| **Subscription** | a reverse index across SET + HASH keys | API (subscribe, unsubscribe), connection teardowns | Transport Manager |

Each connection of a device holds the *list of channels it subscribes to*; a subscription holds the *reverse* — the set of connections subscribed to a channel — so the Transport Manager can go from "this model changed" straight to "these connections, on these transports."

All keys are namespaced under the `nxx:` prefix.

---

## Devices

A device is a JSON document at:

```text
nxx:device:{deviceId}
```

Shape (`NexxusDeviceProps`, plus the session and the connections):

```typescript
{
  id: string;
  appId: string;
  name: string;
  userId?: string;
  lastSeen?: Date;   // when a connection last opened, or a sign-in last reused the device; stored as ISO string
  connections: {     // by connection id; {} when the device has none
    [connectionId: string]: {
      transport: string;       // the queue the connection is reached through
      type: 'volatile' | 'persistent';
      subscriptions: string[]; // subscription *keys* this connection holds (see below)
      connectedAt: string;     // ISO string
      closing?: true;          // set while it is torn down
    };
  };
}
```

A device can hold several connections at once — two browser tabs are two connections of one device — and each connection subscribes on its own. **Connection types** determine subscription lifetime:

- **`volatile`** — connection-oriented transports (e.g. WebSockets). The connection id is minted by the transport per socket, and the connection, with its subscriptions, lasts as long as the socket.
- **`persistent`** — connectionless transports (e.g. Apple Push Notifications). The connection id is the device's push token, and its subscriptions last until the third-party service reports the token invalid.

A connection opens only while the device's session is active, and logging out tears down every connection of the device. A connection's `subscriptions` stores subscription **keys** (strings) — the subscription objects themselves live in the reverse-index keys below. A connection id is 1 to 256 letters, digits, `_`, `:` or `-`.

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

Each channel has a canonical identity key (this is what's stored in a connection's `subscriptions` array):

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

For efficient routing, the connections subscribed to each channel are spread across four key families:

| Family | Key | Type | Contents |
| --- | --- | --- | --- |
| **Partition** | `nxx:subscription:{channel}:p{h}` | SET | `deviceId\|transport\|connectionId` routes for partition `h` |
| **Partition index** | `nxx:subscription-partition-index:{channel}` | HASH | partition (`0`–`f`) → how many members it holds; an empty partition has no field |
| **Scope registry** | `nxx:subscription-scopes:{appId}:{model}` | HASH | scope descriptor → live subscriber count |
| **Filter registry** | `nxx:subscription-filters:{channel}` | HASH | `filterId` → normalized `FilterQuery` JSON, and `count:{filterId}` → how many members use it |

**Partitioning.** Routes in a channel are hash-bucketed into **16 partitions** by `sha256(deviceId)[0] % 16` (rendered as a hex suffix `p0`–`pf`), so all of a device's connections share a partition. This spreads a hot channel's members across multiple keys instead of one giant set. The **partition index** counts the members of each bucket, so a read only touches non-empty partitions.

**Counting.** A member is counted in the scope registry, the partition index and, when filtered, the filter registry before it is added, and those counts go down only after it is removed. Each count is deleted in the same step that takes it to zero. A member that exists is always counted, whatever is added or removed at the same moment.

**Scope registry.** So the Transport Manager doesn't probe channels nobody is listening on, each `(appId, model)` keeps a HASH of *scope descriptors* to subscriber counts. Descriptors are canonical:

```text
*                 → app + model (everyone watching the model)
id:X              → a specific record
user:U            → a user scope
id:X|user:U       → a user's view of a specific record
```

Counts are incremented/decremented as connections subscribe/unsubscribe, and a descriptor is dropped when it hits zero — so the TM can list the *active* scopes for a model and skip the rest.

**Filter registry.** A filtered subscription stores its `FilterQuery` once (keyed by `filterId`) rather than per connection, next to a count of the members using it; the definition is deleted with its last member. The Transport Manager loads the channel's filters and re-evaluates them against the changed model to decide delivery.

### Routes

Partition sets store members as `deviceId|transport|connectionId` (`NexxusDeviceTransportString`), one per subscribed connection:

```text
device-123|websockets-transport_0|0f8fad5b-d9cb-469f-a165-70867728950e
```

The transport is embedded so the Transport Manager knows which transport queue to route the notification to, and the connection id so the transport knows which of the device's connections it is for.

### Fan-out scopes

When a model changes, the Transport Manager expands the change into the set of channel scopes that could match it — app-wide, the owning user's scope, the specific record, and the user's view of that record — then checks each against the scope registry before loading routes. That expansion is produced by `NexxusRedisSubscription.generateSubscriptionPatterns(...)`.

---

## How it fits together

- **API, on sign-in and device registration** — creates the device JSON document, with no connections.
- **Transport, on a connection's register and close** — opens the connection's entry on the device, and tears it down: its routes, then its entry. A register can also tear down other connections of the device: one its client reports lost, and the oldest ones over the application's cap.
- **API, on logout** — tears down every connection of the device.
- **API, on subscribe** — lists the channel on the connection's entry, then adds its route to the channel's partition set, counted in the scope registry, the partition index and, when filtered, the filter registry. On unsubscribe it removes the route, then the listing.
- **Transport Manager, on a model change** — expands the change into candidate scopes, keeps only the active ones (scope registry), reads the routes from that channel's non-empty partitions, applies any filters, and sends each connection's event to its transport queue.

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
- **Lua scripts** — writes that check and change a key in one step run as Lua scripts, kept as `.lua` files in [`src/lib/scripts`](src/lib/scripts) and read when `NexxusRedis` is created. Each is sent with `SCRIPT LOAD` on its first run on a connection, then run by its SHA1 (`EVALSHA`). After a disconnect each is sent again, and one Redis no longer holds is run from its source.

The Redis config declares no env-var or CLI specs, so it comes from the config file (or a custom provider) rather than `NXX_`-prefixed vars.

Partition count is a fixed internal constant (16), not a configuration knob.

---

## Key classes

- **`NexxusRedis`** — the connection wrapper (`init`, `getClient`, `scripts`, `close`, `getStats`); the single entry point to the client.
- **`NexxusRedisScriptLoader`** — runs the Lua scripts: `run(name, { keys, args })` returns the script's result. `NexxusRedis.instance.scripts` is the one for the current connection.
- **`NexxusDevice`** — the device JSON document and its connections; create/get/update, the session methods, and `exists`, which checks many devices at once with one `EXISTS` per device, so it works on a cluster.
  - `openConnection(deviceId, connectionId, { transport, type })` opens a connection with no subscriptions, if the device's session is still active; it returns whether the connection is open.
  - `closeConnection(deviceId, connectionId)` tears a connection down: its routes, then its entry. The device's other connections keep theirs. It returns whether there was one.
  - `addSubscription(deviceId, connectionId, subscription)` and `removeSubscription(...)` subscribe and unsubscribe one connection; a connection that is closing takes no subscription.
  - `getConnections()` returns a loaded device's connections.
- **`NexxusRedisSubscription`** — a channel's reverse index; builds the keys, manages partition membership, the scope registry, and the filter registry, and expands fan-out scopes.
- **`NexxusAuthNonce`** — single-use, expiring nonces scoped to an application, at `nxx:auth-nonce:{appId}:{nonce}`; `issue`, and `consume` as one atomic read-and-delete.
- **`NexxusModelFieldCache`** — the per-object fields ACL conditions are checked against, at `nxx:field-cache:{objectId}`; kept by the Writer, and expiring.
- **`NexxusUsernameLock`** — a lock on one username of one application, at `nxx:username_lock:{appId}:{username}`, held while an account is looked up and created. `acquire` waits up to a few seconds for the holder; `release` frees it only for its holder. It expires on its own after 10 seconds.
- **Exception types** — `RedisConnectionErrorException`, `RedisCommandErrorException`, `RedisKeyNotFoundException`, `RedisDeviceInvalidParamsException`, `RedisDeviceNotConnectedException`.

---

## A note on durability

Redis holds *live routing state*, not the system of record. Volatile-transport subscriptions are inherently ephemeral — they exist only while a connection does — so a Redis restart drops them and clients re-subscribe on reconnect. Enable Redis persistence (RDB/AOF) if you want device/persistent-subscription state to survive restarts.

---

## Status

🚧 Pre-alpha. Structures and key layout are still moving; breaking changes land without deprecation shims.

## License

MPL-2.0
