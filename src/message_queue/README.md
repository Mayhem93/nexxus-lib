# @mayhem93/nexxus-message-queue-lib

> Message-broker abstraction for Nexxus — a pluggable adapter contract plus a built-in RabbitMQ implementation.

---

## Overview

Nexxus moves work between its nodes over a message broker: the API hands writes off asynchronously, workers consume and re-publish, and transport workers fan changes out to clients. This package defines **how a broker is plugged in** without committing to a specific one:

- **`NexxusMessageQueueAdapter`** — the abstract contract every adapter implements. The base class already owns the hard parts (connection state machine with retry, consumer bookkeeping, pause/resume, failed-message handling, optional compression); a concrete adapter fills in a small `do*` surface.
- **`NexxusMessageQueueBootstrapper`** — the deployment-time hook that declares broker topology (exchanges, per-stage queues, dead-letter queues).
- A built-in **RabbitMQ** adapter, bootstrapper, and an **lz4** message compressor.

This README targets **adapter authors** — RabbitMQ is the reference, not the subject.

---

## Features

- **Pluggable adapter contract** — back Nexxus with any broker by implementing a handful of `do*` methods.
- **Base-owned connection lifecycle** — retry-until-connected, reconnect handling, and `connect`/`disconnect` events live in the base class, not each adapter.
- **Consumer durability across reconnects** — registered consumers are restored automatically when the connection returns.
- **Pause / resume** — consumption can be gated (workers pause when a downstream dependency is unavailable).
- **Failed-message handling** — retries with backoff, dead-lettering, and no retries wasted on an outage; see [Failed messages](#failed-messages).
- **Graceful stop** — `stopConsuming()` lets in-flight messages finish before shutdown.
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
- `consumeMessages(queue, handler, options?)` — registers and retains the `(queue, handler)` tuple, dispatches it, and **re-establishes it automatically** after a reconnect. Every message it receives is decoded, handed to `handler` and settled by the base — see [Failed messages](#failed-messages).
- `pauseConsuming()` / `resumeConsuming()` — idempotent gates over all consumers.
- `stopConsuming(timeoutMs = 10000)` — stops for good ahead of shutdown: cancels every consumer, hands back messages waiting for a retry, and waits up to `timeoutMs` for messages being processed. Safe to call more than once.
- `publishMessage(queue, message, metadata?)` — encodes the message and hands it to `doPublish`. Resolves once the broker confirms it; throws a `NexxusMessageQueuePublishException` when there's no connection, the broker refuses it, the connection goes first, or no confirmation arrives within `publishTimeout` seconds.
- `serializePayload()` / `deserializePayload()` — JSON encode/decode plus optional compression, on both paths.

**A concrete adapter implements** the small broker-specific surface:

| Method | Responsibility |
| --- | --- |
| `doConnect()` | Open the connection; wire the client's close handler to call `onConnectionLost()`. |
| `doDisconnect()` | Close the connection cleanly (safe if nothing is open). |
| `isFatalConnectError(err)` | Classify a connect error as fatal (give up) vs retryable (default to retryable). |
| `doConsume(queue, deliver)` | Start a broker consumer that hands each message to `deliver` as a `NexxusMessageDelivery`; track whatever handle is needed to cancel it. |
| `doCancelAll()` | Cancel all active consumers (for pause); swallow per-consumer errors. |
| `doPublish(queue, content, metadata?)` | Send the encoded bytes. Resolve once the broker confirms the message; reject when it refuses it or the connection goes first, and at once when there's no connection. |
| `queueExists` / `createVolatileQueue` / `deleteQueue` | Support the per-slot volatile queues transport workers claim. |
| `getBootstrapper(options)` | Return this adapter's `NexxusMessageQueueBootstrapper`. |
| `reconnectDelayMs` | The retry interval the base's loop uses. |

---

## Publishing & consuming

```typescript
// Publish — the payload type is inferred from the queue name. Resolves once the
// broker confirms the message; throws a NexxusMessageQueuePublishException otherwise.
await mq.publishMessage('writer', {
  event: 'model_created',
  data: appModel.getData(),
});

// Consume — register once; the base restores it across reconnects.
await mq.consumeMessages('writer', async (message) => {
  const payload = message.payload; // typed as the 'writer' queue's payload
  // …process… — resolve to ack the message, throw to fail it
}, {
  // The services the handler needs. Optional: without them, every failure counts.
  isReady: () => database.isUp(),
  waitUntilReady: () => database.whenUp(),
});

// Gate consumption (e.g. a worker whose database dropped)
await mq.pauseConsuming();
await mq.resumeConsuming();

// Before shutting down: let in-flight messages finish
await mq.stopConsuming();
```

`publishMessage<Q>` and `consumeMessages<Q>` are generic over the queue name, and `NexxusQueuePayload<Q>` maps each known queue to its payload type — so publishing the wrong shape to a queue is a compile error.

---

## Failed messages

The base settles every message it hands a handler:

| The handler… | The message is… |
| --- | --- |
| resolves | acknowledged |
| throws a `NexxusException` with `terminal: true` (invalid data, an unknown application or model type) | dead-lettered at once |
| throws anything else | retried after 1 s, 2 s and 4 s, then dead-lettered |
| throws while `isReady()` is false | held until `waitUntilReady()` resolves, then retried; the failure doesn't count as a retry |

- A payload that can't be decoded is dead-lettered without reaching the handler.
- A message waiting for a retry when `stopConsuming()` is called goes back to its queue.
- Dead-lettered means the broker moves it to the queue's dead-letter queue, or drops it from a queue that has none.
- Each retry and each dead-lettering is logged with the queue, the event and the error.

---

## Message payloads

Payloads live in core (`@mayhem93/nexxus-core-lib`) and are keyed to queues by type. The three hops of the base pipeline:

**`writer` queue** — `NexxusWriterPayload`:

```typescript
{ event: 'model_created', data: INexxusAppModel }
{ event: 'model_updated', data: NexxusJsonPatchInternal[] }               // one entry per patch
{ event: 'model_deleted', data: { id, type, appId } }
```

**`transport-manager` queue** — `NexxusTransportManagerPayload`. Same events. On an application with users, the Writer adds the record's stored owner as `userId` — on each update patch's `metadata`, and on a delete's `data`. Each update patch also carries the post-write partial model the Writer produced, and a delete carries the record's filterable fields as they were before it, in `data.partialModel`:

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

- **`bootstrapDeployment(pipeline)`** — idempotent, one-shot: declare the cross-node broadcast surface plus one queue per **static** pipeline stage, each with somewhere to dead-letter to. Dynamic per-slot stages are skipped — the worker that claims a slot declares its own `<stage>_<n>` queue, and those get no dead-letter queue. Migration is explicitly out of scope.

The RabbitMQ bootstrapper runs entirely over the broker's **HTTP management API** (so it can run before any AMQP connection exists — it's what creates the vhost the adapter later connects to). It declares, in order:

1. the `/nexxus` vhost, the runtime user, and its per-vhost permissions;
2. the `systemMessages` fanout exchange (cross-node broadcast; workers bind their own ephemeral queues to it);
3. the `deadLetters` direct exchange;
4. per static stage: a durable **quorum** queue, and a `<stage>.dlq` quorum queue bound to `deadLetters` by the stage's name;
5. the `nexxus-dead-letter` policy, which points the stage queues at `deadLetters`;
6. the `nexxus-dead-letter-retention` policy, which discards a dead-lettered message once it is older than `deadLetterRetention`, and the oldest message once a dead-letter queue holds `deadLetterMaxLength`.

Re-running it on an existing deployment adds the dead-letter queues and policies, and applies a changed `deadLetterRetention` or `deadLetterMaxLength`; the stage queues are left as they are.

---

## Writing a custom adapter

To back Nexxus with a different broker:

1. **Extend `NexxusMessageQueueAdapter<Config, Events, Stats>`** and set the static config hooks from `NexxusBaseService` — `configRootKey` is `'message_queue'`; provide `schemaPath` (JSON schema for your config) and any `envVars`/`cliArgs`.
2. **Implement the `do*` surface** from the table above, plus the volatile-queue trio, `getBootstrapper`, and `reconnectDelayMs`. You do **not** reimplement `connect`/`disconnect`/`consumeMessages`/`publishMessage`/`pause`/`resume` — those are the base's.
3. **Ship a `NexxusMessageQueueBootstrapper` subclass** that declares your broker's topology.

Watch out for:

- **Wire the close handler.** In `doConnect`, hook the client's "connection closed" event to `this.onConnectionLost()` — that's what lets the base restart the retry loop. Do **not** call it from `doDisconnect` (that's the graceful path the base already owns).
- **Don't encode or decode messages yourself.** `doPublish` receives the bytes ready to send, and `deliver` takes them as they arrived; the base applies JSON and compression on both sides.
- **Only resolve `doPublish` on the broker's confirmation.** Resolving as soon as the bytes are written makes the API answer `202` for a write the broker may never have stored.
- **Track consumer handles.** `doConsume` must remember whatever token cancels a consumer so `doCancelAll` can stop it; expect `doConsume` to be called again on reconnect and on resume.
- **Let the base settle messages.** Never ack in `doConsume`. Hand each message to `deliver` with its raw `content`, its `metadata`, and three ways to settle it — `ack`, `deadLetter` (reject without requeue, or your broker's equivalent) and `requeue` — plus `isLive()`, which turns false once the connection the message arrived on is gone. The base calls exactly one of the three, and none once `isLive()` is false.
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
    "prefetch": 10,            // most unacknowledged messages a consumer holds at once; default 10
    "publishTimeout": 5,       // seconds to wait for the broker to confirm a publish: 1 to 30, default 5
    "deadLetterRetention": 259200, // seconds a dead-lettered message is kept: 3 days (default and minimum) to 30 days
    "deadLetterMaxLength": 100,    // most messages each dead-letter queue keeps, oldest dropped first: 10 to 500, default 100

    // Optional, deployment-wide. Every producer AND consumer must match.
    "compression": {
      "enabled": true,
      "algo": "lz4",
      "options": {}
    }
  }
}
```

The RabbitMQ adapter declares `NXX_`-prefixed, typed env vars: `NXX_MQ_HOST` (string), `NXX_MQ_PORT` (int), `NXX_MQ_USER` (string), `NXX_MQ_PASSWORD` (string). `compression` and `publishTimeout` are read by the base, from the shared `NexxusMessageQueueConfig`, so every adapter honours them; its schema has to declare them.

---

## Built-in adapter: RabbitMQ

`NexxusRabbitMq` is the reference adapter. What's RabbitMQ-specific about it:

- **Two queue shapes.** Static pipeline stages are **durable quorum** queues; the per-slot queues transport workers claim are **classic non-durable + exclusive + auto-delete** — exclusivity gives broker-level collision detection when two workers race for the same slot, and auto-delete cleans them up on disconnect.
- **Fanout for broadcast.** A `systemMessages` fanout exchange carries one-message-to-every-node traffic, separate from the competing-consumer work queues.
- **Connects over AMQP** to the `/nexxus` vhost with a heartbeat; the bootstrapper works over the **management HTTP API** instead, so provisioning needs no live AMQP connection.
- **Consumer tags** are tracked per queue so consumers can be cancelled for `pauseConsuming` and re-registered on reconnect.
- **Prefetch** caps the unacknowledged messages a consumer holds (`prefetch`, default 10). Without one, RabbitMQ hands a consumer every ready message at once.
- **Dead-lettering is a reject without requeue.** The bootstrapper's policy routes a rejected stage message to `<stage>.dlq`; the per-slot transport queues have no dead-letter queue, so there the same reject drops it.
- **Settled on the channel it arrived on.** A message whose channel has closed is left alone: the broker has already requeued it.
- **Persistent publishes on a confirm channel.** The broker acknowledges every message; one it refuses, or one still unconfirmed when the channel closes, fails its publish. The content-type reflects whether the body is compressed.

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

- **`NexxusMessageQueueAdapter`** *(abstract)* — the contract. **You should have** a `do*` implementation for connect/disconnect/consume/cancel/publish; **watch out** that you wire the close handler to `onConnectionLost()` and resolve `doPublish` only on the broker's confirmation.
- **`NexxusMessageQueuePublishException`** — what `publishMessage` throws when the broker didn't confirm a message.
- **`NexxusMessageQueueBootstrapper`** *(abstract)* — deployment topology. **You should** make every declare idempotent; **watch out** to skip dynamic per-slot stages (workers declare those).
- **`NexxusMessageCompressor`** — deployment-wide compression. **Watch out**: it's all-or-nothing across the fleet, since messages carry no algo marker.
- **`NexxusRabbitMq` / `NexxusRabbitMqBootstrapper`** — the reference implementation and its management-API-based provisioning.

---

## Status

🚧 Pre-alpha. The adapter/bootstrapper contracts and the pipeline model are still moving; breaking changes land without deprecation shims.

## License

MPL-2.0
