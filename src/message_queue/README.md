# @mayhem93/nexxus-message-queue-lib

> Message-broker abstraction for Nexxus — a pluggable adapter contract plus a built-in RabbitMQ implementation.

---

## Overview

Nexxus moves work between its nodes over a message broker: the API hands writes off asynchronously, workers consume and re-publish, and transport workers fan changes out to clients. This package defines **how a broker is plugged in** without committing to a specific one:

- **`NexxusMessageQueueAdapter`** — the abstract contract every adapter implements. The base class already owns the hard parts (connection state machine with retry, consumer bookkeeping, pause/resume, optional compression); a concrete adapter fills in a small `do*` surface.
- **`NexxusMessageQueueBootstrapper`** — the deployment-time hook that declares broker topology (exchanges, per-stage queues).
- A built-in **RabbitMQ** adapter, bootstrapper, and an **lz4** message compressor.

This README targets **adapter authors** — RabbitMQ is the reference, not the subject.

---

## Features

- **Pluggable adapter contract** — back Nexxus with any broker by implementing a handful of `do*` methods.
- **Base-owned connection lifecycle** — retry-until-connected, reconnect handling, and `connect`/`disconnect` events live in the base class, not each adapter.
- **Consumer durability across reconnects** — registered consumers are restored automatically when the connection returns.
- **Pause / resume** — consumption can be gated (workers pause when a downstream dependency is unavailable).
- **Optional wire compression** — deployment-wide payload compression (lz4 today) handled transparently by the base.
- **Type-safe payloads** — queue name → payload type is enforced at compile time via `NexxusQueuePayload<Q>`.

---

## Message flow & the pluggable pipeline

The data pipeline is a chain of queues connected by workers. The **only** pipeline wired up today is the base one:

```text
API ──▶ writer ──▶ transport-manager ──▶ <transport> ──▶ clients
```

- `writer` — the API publishes app-model writes here; the Writer worker persists them.
- `transport-manager` — the Writer republishes change events here; the Transport Manager routes them to the right per-device channels.
- `<transport>` — a **transport adapter** delivers to connected clients. WebSockets is one such transport; it is not the only one (an MQTT transport is planned), so the final stage is deliberately not a hardcoded queue name — it's whichever transport(s) a deployment runs.

The pipeline is **pluggable**: it's just queues and workers, so custom workers can be inserted along the chain and adjusted to an application's needs. `NexxusQueueName` is `known-names | (string & {})`, so custom stages are first-class. (Customizing the pipeline is still a work in progress — the base chain above is what runs today.)

Queue names come in two shapes: **static** stages (`writer`, `transport-manager`) and **dynamic per-slot** stages for horizontally-scaled transports, named `<pattern>_<n>` (e.g. `websockets-transport_1`).

---

## The adapter interface

`NexxusMessageQueueAdapter` extends core's `NexxusBaseService`, so an adapter is a config-bound service (config subtree under `message_queue`, typed events, `getStats()`):

```typescript
abstract class NexxusMessageQueueAdapter<
  T extends NexxusMessageQueueConfig,          // its "message_queue" config subtree
  Ev extends NexxusMessageQueueAdapterEvents,  // connect / disconnect / error / message
  TStats extends NexxusMessageQueueAdapterStats
> extends NexxusBaseService<T, Ev, TStats> { … }
```

**The base class already implements**, so you don't:

- `connect()` / `disconnect()` — a full state machine: retry-until-connected, reconnect on unexpected drops, one-shot resolution of the first connect, and the `connect`/`disconnect` events.
- `consumeMessages(queue, handler)` — registers and retains the `(queue, handler)` tuple, dispatches it, and **re-establishes it automatically** after a reconnect.
- `pauseConsuming()` / `resumeConsuming()` — idempotent gates over all consumers.
- `serializePayload()` / `deserializePayload()` — JSON encode/decode plus optional compression.

**A concrete adapter implements** the small broker-specific surface:

| Method | Responsibility |
| --- | --- |
| `doConnect()` | Open the connection; wire the client's close handler to call `onConnectionLost()`. |
| `doDisconnect()` | Close the connection cleanly (safe if nothing is open). |
| `isFatalConnectError(err)` | Classify a connect error as fatal (give up) vs retryable (default to retryable). |
| `doConsume(queue, handler)` | Start a broker consumer; track whatever handle is needed to cancel it. |
| `doCancelAll()` | Cancel all active consumers (for pause); swallow per-consumer errors. |
| `publishMessage(queue, message, metadata?)` | Publish, using `serializePayload()` for the wire bytes. |
| `queueExists` / `createVolatileQueue` / `deleteQueue` | Support the per-slot volatile queues transport workers claim. |
| `getBootstrapper(options)` | Return this adapter's `NexxusMessageQueueBootstrapper`. |
| `reconnectDelayMs` | The retry interval the base's loop uses. |

---

## Publishing & consuming

```typescript
// Publish — the payload type is inferred from the queue name.
await mq.publishMessage('writer', {
  event: 'model_created',
  data: appModel.getData(),
});

// Consume — register once; the base restores it across reconnects.
await mq.consumeMessages('writer', async (message) => {
  const payload = message.payload; // typed as the 'writer' queue's payload
  // …process…
  // (the built-in RabbitMQ adapter acks after the handler resolves;
  //  a throwing handler leaves the message unacked)
});

// Gate consumption (e.g. a worker whose database dropped)
await mq.pauseConsuming();
await mq.resumeConsuming();
```

`publishMessage<Q>` and `consumeMessages<Q>` are generic over the queue name, and `NexxusQueuePayload<Q>` maps each known queue to its payload type — so publishing the wrong shape to a queue is a compile error.

---

## Message payloads

Payloads live in core (`@mayhem93/nexxus-core-lib`) and are keyed to queues by type. The three hops of the base pipeline:

**`writer` queue** — `NexxusWriterPayload`:

```typescript
{ event: 'model_created', data: INexxusAppModel }
{ event: 'model_updated', data: NexxusJsonPatchInternal[] }               // one entry per patch
{ event: 'model_deleted', data: { id, type, appId, userId } }
```

**`transport-manager` queue** — `NexxusTransportManagerPayload`. Same events, but each update patch now also carries the post-write partial model the Writer produced:

```typescript
{
  event: 'model_updated',
  data: Array<{ op, path, value, metadata: { …, partialModel: Partial<INexxusAppModel> } }>
}
```

**Transport queues** (`<transport>_<n>`) — `NexxusTransportWorkerPayload`, identical across every transport so each adapter just re-encodes `data` into its own wire format:

```typescript
{
  event: 'device_message',
  deviceIds: string[],                 // who to deliver to
  data: {                              // model_created | model_updated | model_deleted
    event: 'model_updated',
    model: { id, type, appId, userId, version },  // version drives client gap-detection
    patches: Array<{ op, path, value }>,
    metadata: { channels: string[] }              // matched subscription channels
  }
}
```

---

## Deployment bootstrapping

Runtime publish/consume assumes the broker topology already exists. Declaring it is a separate concern handled by `NexxusMessageQueueBootstrapper`, obtained via `getBootstrapper(options)` and run by the CLI/Hub (never by a regular node). Its one hook:

- **`bootstrapDeployment(pipeline)`** — idempotent, one-shot: declare the cross-node broadcast surface plus one queue per **static** pipeline stage. Dynamic per-slot stages are skipped — the worker that claims a slot declares its own `<stage>_<n>` queue. Migration is explicitly out of scope.

The RabbitMQ bootstrapper runs entirely over the broker's **HTTP management API** (so it can run before any AMQP connection exists — it's what creates the vhost the adapter later connects to). It declares, in order: the `/nexxus` vhost, the runtime user + its per-vhost permissions, the `systemMessages` fanout exchange (cross-node broadcast; workers bind their own ephemeral queues to it), and one durable **quorum** queue per static stage.

---

## Writing a custom adapter

To back Nexxus with a different broker:

1. **Extend `NexxusMessageQueueAdapter<Config, Events, Stats>`** and set the static config hooks from `NexxusBaseService` — `configRootKey` is `'message_queue'`; provide `schemaPath` (JSON schema for your config) and any `envVars`/`cliArgs`.
2. **Implement the `do*` surface** from the table above, plus `publishMessage`, the volatile-queue trio, `getBootstrapper`, and `reconnectDelayMs`. You do **not** reimplement `connect`/`disconnect`/`consumeMessages`/`pause`/`resume` — those are the base's.
3. **Ship a `NexxusMessageQueueBootstrapper` subclass** that declares your broker's topology.

Watch out for:

- **Wire the close handler.** In `doConnect`, hook the client's "connection closed" event to `this.onConnectionLost()` — that's what lets the base restart the retry loop. Do **not** call it from `doDisconnect` (that's the graceful path the base already owns).
- **Use `serializePayload`/`deserializePayload`.** Encode/decode through them rather than raw `JSON.stringify`, or compression silently won't apply.
- **Track consumer handles.** `doConsume` must remember whatever token cancels a consumer so `doCancelAll` can stop it; expect `doConsume` to be called again on reconnect and on resume.
- **Acknowledge after the handler.** Ack/commit only once the handler resolves, so a failure requeues rather than drops.
- **Classify errors conservatively.** `isFatalConnectError` should return `true` only for things retrying can't fix (e.g. bad credentials); everything else stays retryable.
- **Peer-depend on `@mayhem93/nexxus-core-lib`** so `instanceof` checks resolve against one shared copy. Point `app.message_queue` at your package name and the framework dynamic-imports it.

---

## Configuration

An adapter's config lives under the `message_queue` key and must be backed by a JSON schema (`schemaPath`) — see [`src/schemas/rabbitmq.schema.json`](src/schemas/rabbitmq.schema.json). The RabbitMQ shape:

```jsonc
{
  "message_queue": {
    "host": "localhost",
    "port": 5672,
    "user": "nexxus",
    "password": "…",
    "managementPort": 15672,   // used by the bootstrapper's management-API calls

    // Optional, deployment-wide. Every producer AND consumer must match.
    "compression": {
      "enabled": true,
      "algo": "lz4",
      "options": {}
    }
  }
}
```

The RabbitMQ adapter declares `NXX_`-prefixed, typed env vars: `NXX_MQ_HOST` (string), `NXX_MQ_PORT` (int), `NXX_MQ_USER` (string), `NXX_MQ_PASSWORD` (string). Compression is inherited from the shared `NexxusMessageQueueConfig`, so every adapter picks it up for free.

---

## Built-in adapter: RabbitMQ

`NexxusRabbitMq` is the reference adapter. What's RabbitMQ-specific about it:

- **Two queue shapes.** Static pipeline stages are **durable quorum** queues; the per-slot queues transport workers claim are **classic non-durable + exclusive + auto-delete** — exclusivity gives broker-level collision detection when two workers race for the same slot, and auto-delete cleans them up on disconnect.
- **Fanout for broadcast.** A `systemMessages` fanout exchange carries one-message-to-every-node traffic, separate from the competing-consumer work queues.
- **Connects over AMQP** to the `/nexxus` vhost with a heartbeat; the bootstrapper works over the **management HTTP API** instead, so provisioning needs no live AMQP connection.
- **Consumer tags** are tracked per queue so consumers can be cancelled for `pauseConsuming` and re-registered on reconnect.
- **Persistent publishes**, with the content-type reflecting whether the body is compressed.

Compression is provided by `NexxusMessageCompressor` (lz4 via `lz4-napi`), applied by the base adapter — messages carry no per-message algo marker, so it's strictly a deployment-wide setting.

---

## Custom worker pipelines

Because the pipeline is just queues and workers, a deployment can insert its own workers along the chain — a worker consumes one stage, does its thing, and publishes onward. Some shapes this is meant to enable (still design-stage — the base chain is what runs today):

- **Data masking / redaction** — sit between the Writer and the transports and strip or tokenize sensitive fields before they fan out to clients.
- **Security / policy** — an authorization or content-policy gate that drops or flags events that violate a rule before they propagate.
- **Monitoring / metrics** — a passive consumer on a broadcast copy of events that emits metrics or traces without altering the flow.
- **External sinks** — a worker that forwards a copy of events to an analytics warehouse, a search index, or a third-party system.

The general pattern is the same: a stage publishes to the next queue name, custom workers subscribe where they need to, and the transport stage stays whatever transport adapter(s) the deployment runs.

---

## Key classes

For someone writing an adapter over a different broker:

- **`NexxusMessageQueueAdapter`** *(abstract)* — the contract. **You should have** a `do*` implementation for connect/disconnect/consume/cancel and a `publishMessage`; **watch out** that you wire the close handler to `onConnectionLost()` and encode through `serializePayload`.
- **`NexxusMessageQueueBootstrapper`** *(abstract)* — deployment topology. **You should** make every declare idempotent; **watch out** to skip dynamic per-slot stages (workers declare those).
- **`NexxusMessageCompressor`** — deployment-wide compression. **Watch out**: it's all-or-nothing across the fleet, since messages carry no algo marker.
- **`NexxusRabbitMq` / `NexxusRabbitMqBootstrapper`** — the reference implementation and its management-API-based provisioning.

---

## Status

🚧 Pre-alpha. The adapter/bootstrapper contracts and the pipeline model are still moving; breaking changes land without deprecation shims.

## License

MPL-2.0
