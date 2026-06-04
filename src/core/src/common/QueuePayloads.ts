import { INexxusAppModel } from '../models/AppModel';
import { NexxusJsonPatchInternal, NexxusJsonPatchMetadata } from '../common/JsonPatch';

export interface NexxusBaseQueuePayload {
  event: string;
  [key: string]: any;
}

export type NexxusModelCreatedPayload = { event: 'model_created'; data: INexxusAppModel; };
export type NexxusModelUpdatedPayload = { event: 'model_updated'; data: Array<NexxusJsonPatchInternal>; };

export type NexxusModelDeletedData = Pick<INexxusAppModel, 'id' | 'type' | 'appId' | 'userId'>;
export type NexxusModelDeletedPayload = { event: 'model_deleted'; data: NexxusModelDeletedData; };

// Built-in worker payloads
export type NexxusWriterPayload = NexxusModelCreatedPayload | NexxusModelUpdatedPayload | NexxusModelDeletedPayload;

export type NexxusTransportManagerJsonPatch = Omit<NexxusJsonPatchInternal, 'metadata'> & {
  metadata: NexxusJsonPatchMetadata & { partialModel: Partial<INexxusAppModel> };
};

export type NexxusTransportManagerModelUpdatedPayload = {
  event: 'model_updated';
  data: Array<NexxusTransportManagerJsonPatch>;
}

export type NexxusTransportManagerPayload = NexxusModelCreatedPayload | NexxusTransportManagerModelUpdatedPayload | NexxusModelDeletedPayload;

/**
 * Metadata for transport-bound model events (create/update/delete alike).
 * Carries the channels that matched the subscription router for this device,
 * so the client can correlate the event with its local subscription containers.
 */
export interface NexxusTransportMetadata {
  channels: Array<string>;
}

/**
 * Payload for any transport worker - model created
 */
export type NexxusTransportModelCreatedPayload = {
  event: 'model_created';
  model: INexxusAppModel;
  metadata: NexxusTransportMetadata;
};

/**
 * Payload for any transport worker - model deleted
 */
export type NexxusTransportModelDeletedPayload = {
  event: 'model_deleted';
  model: NexxusModelDeletedData;
  metadata: NexxusTransportMetadata;
};

/**
 * Payload for any transport worker - model updated.
 * All patches in a single event target the same model — its identity is hoisted
 * into `model`, and the matched channels into top-level `metadata`. Per-patch
 * metadata is intentionally absent (it was redundant across patches of the same
 * update event under the previous shape).
 */
export type NexxusTransportModelUpdatedPayload = {
  event: 'model_updated';
  /**
   * Includes `version` — the post-update version stamp assigned by the adapter.
   * Clients use it for gap detection: apply if `model.version === local.version + 1`,
   * request a fresh GET if there's a gap, ignore if it's already been applied.
   */
  model: Pick<INexxusAppModel, 'id' | 'type' | 'appId' | 'userId' | 'version'>;
  patches: Array<Omit<NexxusJsonPatchInternal, 'metadata'>>;
  metadata: NexxusTransportMetadata;
};

/**
 * Canonical payload consumed by ALL transport workers (volatile and persistent alike).
 * The shape is identical across transports; each transport translates the inner `data`
 * into its own wire format inside its `sendToDevice` implementation.
 */
export type NexxusTransportWorkerPayload = {
  event: 'device_message';
  deviceIds: Array<string>;
  data: NexxusTransportModelCreatedPayload | NexxusTransportModelUpdatedPayload | NexxusTransportModelDeletedPayload;
};

// Map of built-in queue names to their payloads
export interface NexxusBuiltInQueuePayloadMap {
  'writer': NexxusWriterPayload;
  'transport-manager': NexxusTransportManagerPayload;
}

// Map of dynamic queue patterns to their payloads.
// All transport-worker queues carry the same canonical payload; the queue-name
// prefix only identifies which transport worker pool consumes from it.
export interface NexxusDynamicQueuePayloadMap {
  'websockets-transport': NexxusTransportWorkerPayload;
  'mqtt-transport': NexxusTransportWorkerPayload;
}

// Built-in queue names (static)
export type NexxusBuiltInQueueName = keyof NexxusBuiltInQueuePayloadMap;

// Dynamic queue patterns
export type NexxusDynamicQueueType = keyof NexxusDynamicQueuePayloadMap;

export type NexxusDynamicQueuePattern = keyof NexxusDynamicQueuePayloadMap;

// Dynamic queue names: pattern_number (e.g., "websockets_1", "mqtt_2")
export type NexxusDynamicQueueName<T extends NexxusDynamicQueuePattern = NexxusDynamicQueuePattern> = `${T}_${number}`;

// All known queue types
export type NexxusKnownQueueName =
  | NexxusBuiltInQueueName
  | NexxusDynamicQueueName;

// Queue name can be known or any string (for plugins)
export type NexxusQueueName = NexxusKnownQueueName | (string & {});

// Helper to extract pattern from queue name
type ExtractQueuePattern<Q extends string> =
  Q extends `${infer Pattern}_${number}`
    ? Pattern extends NexxusDynamicQueuePattern
      ? Pattern
      : never
    : never;

// Helper to extract queue type from dynamic queue name
export type ExtractQueueType<Q extends string> =
  Q extends `${infer Type}_${number}`
  ? Type extends NexxusDynamicQueueType
    ? Type
    : never
  : never;

// Get payload type for a queue name
export type NexxusQueuePayload<Q extends NexxusQueueName> =
  Q extends NexxusBuiltInQueueName
    ? NexxusBuiltInQueuePayloadMap[Q]
    : Q extends NexxusDynamicQueueName
      ? ExtractQueuePattern<Q> extends NexxusDynamicQueuePattern
        ? NexxusDynamicQueuePayloadMap[ExtractQueuePattern<Q>]
        : NexxusBaseQueuePayload
      : NexxusBaseQueuePayload;
