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

export interface NexxusWebSocketJsonPatchMetadata {
  id: string;
  channels: Array<string>; // Channel key from NexxusRedisSubscription.getKey()
}

/**
 * Metadata for WebSocket model created/deleted events
 */
export interface NexxusWebSocketMetadata {
  channels: Array<string>;
}

/**
 * Payload for WebSocket Transport - model created
 */
export type NexxusWebSocketModelCreatedPayload = {
  event: 'model_created';
  model: INexxusAppModel;
  metadata: NexxusWebSocketMetadata;
};

/**
 * Payload for WebSocket Transport - model deleted
 */
export type NexxusWebSocketModelDeletedPayload = {
  event: 'model_deleted';
  model: NexxusModelDeletedData;
  metadata: NexxusWebSocketMetadata;
};

/**
 * JsonPatch type for WebSocket transport workers
 */
export type NexxusWebSocketJsonPatch = Omit<NexxusJsonPatchInternal, 'metadata'> & {
  metadata: NexxusWebSocketJsonPatchMetadata;
};

/**
 * Payload for WebSocket Transport - slim metadata with just channel
 */
export type NexxusWebSocketModelUpdatedPayload = {
  event: 'model_updated';
  data: Array<NexxusWebSocketJsonPatch>;
};

// Payload for websocket workers (dynamic instances)
export type NexxusWebsocketPayload = {
  event: 'device_message';
  deviceIds: Array<string>;
  data: NexxusWebSocketModelCreatedPayload | NexxusWebSocketModelUpdatedPayload | NexxusWebSocketModelDeletedPayload;
};

export type NexxusMqttPayload =
  | { event: 'mqtt_publish'; topic: string; payload: Buffer; }
  | { event: 'mqtt_subscribe'; topic: string; };

// Map of built-in queue names to their payloads
export interface NexxusBuiltInQueuePayloadMap {
  'writer': NexxusWriterPayload;
  'transport-manager': NexxusTransportManagerPayload;
}

// Map of dynamic queue patterns to their payloads
export interface NexxusDynamicQueuePayloadMap {
  'websockets-transport': NexxusWebsocketPayload;
  'mqtt-transport': NexxusMqttPayload;
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
