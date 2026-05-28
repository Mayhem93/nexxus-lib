import {
  NexxusWsException,
  NexxusWsInvalidParametersException,
  NexxusWsInternalServerException,
  NexxusWsDeviceNotFoundException
} from "./Exceptions";
import { NexxusWebsocketsTransportWorker } from "../WebsocketsTransportWorker";

import { NexxusDevice, RedisKeyNotFoundException } from "@mayhem93/nexxus-redis";
import {
  NexxusTransportModelCreatedPayload,
  NexxusTransportModelDeletedPayload,
  NexxusTransportModelUpdatedPayload
} from "@mayhem93/nexxus-core-lib";

import { WebSocket, Data as WebSocketData } from "ws";

import { EventEmitter } from "node:events";

export type ClientEventMap = {
  register: [ deviceId: string ];
}

export interface NexxusWsBaseEvent {
  event: string;
  data: any;
}

// Client → Server events
export type NexxusWsClientMessage = {
  register: {
    deviceId: string;
  };
  // Add more client events here
};

// Server → Client events
export type NexxusWsServerMessage = {
  register: {
    success: boolean;
    message?: string;
  };
  model_created: NexxusTransportModelCreatedPayload;
  model_updated: NexxusTransportModelUpdatedPayload;
  model_deleted: NexxusTransportModelDeletedPayload;
  error: {
    message: string;
    code?: string;
  };
  // Add more server events here
};

// Helper types for type-safe messaging
export type NexxusWsClientEvent<E extends keyof NexxusWsClientMessage = keyof NexxusWsClientMessage> = {
  event: E;
  data: NexxusWsClientMessage[E];
};

export type NexxusWsServerEvent<E extends keyof NexxusWsServerMessage = keyof NexxusWsServerMessage> = {
  event: E;
  data: NexxusWsServerMessage[E];
};

export class NexxusWsClient extends EventEmitter<ClientEventMap> {
  private socket : WebSocket;
  private deviceId?: string;
  public readonly id: string;

  constructor(clientId: string, ws: WebSocket) {
    super();

    this.socket = ws;
    this.id = clientId;

    this.socket.on('message', async (msg: WebSocketData) => {
      const message = JSON.parse(msg.toString()) as NexxusWsClientEvent;

      if (!message.event) {
        this.sendError(new NexxusWsInvalidParametersException('Missing event type in message.'));

        return;
      }

      if (!message.data) {
        this.sendError(new NexxusWsInvalidParametersException('Missing data in message.'));

        return;
      }

      await this.processMessage(message);
    });
  }

  public isRegistered() : boolean {
    return !!this.deviceId;
  }

  public getDeviceId() : string | undefined {
    return this.deviceId;
  }

  public async processMessage(message: NexxusWsClientEvent) {
    try {
      switch (message.event) {
        case 'register':
          await this.registerDevice(message);

          break;
        default:
          NexxusWebsocketsTransportWorker.logger.warn(`Unknown client event: ${message.event}`, 'NexxusWsClient');
      }
    } catch (e) {
      if (!(e instanceof NexxusWsException)) {
        e = new NexxusWsInternalServerException('An unexpected error occurred while processing the message.');
      }

      NexxusWebsocketsTransportWorker.logger.error(`Error processing message from client "${this.id}"`, { error: e }, 'NexxusWsClient');
      this.sendError(e);
    }
  }

  public sendError(error: NexxusWsException) {
    const errorMessage: NexxusWsServerEvent<'error'> = {
      event: 'error',
      data: {
        message: error.message,
        code: error.name
      }
    };

    this.socket.send(JSON.stringify(errorMessage));
  }

  public sendMessage<E extends keyof NexxusWsServerMessage>(event: E, data: NexxusWsServerMessage[E]) {
    // const message: NexxusWsServerEvent<E> = data;

    this.socket.send(JSON.stringify({ event, data }));
    NexxusWebsocketsTransportWorker.logger.debug(`Sent ${event} message to client ${this.id}`, { data }, 'NexxusWsClient');
  }

  private async registerDevice(msg: NexxusWsClientEvent<'register'>) {
    if (this.isRegistered()) {
      NexxusWebsocketsTransportWorker.logger.warn(`Client ${this.id} is already registered with device ID: "${this.deviceId}"`, 'NexxusWsClient');

      return ;
    }

    const deviceId = msg.data.deviceId;

    if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
      throw new NexxusWsInvalidParametersException('Invalid or missing deviceId.');
    }

    try {
      await NexxusDevice.get(deviceId);
    } catch (e) {
      if (e instanceof RedisKeyNotFoundException) {
        this.sendError(new NexxusWsDeviceNotFoundException(`Device with ID "${deviceId}" not found.`));
      } else {
        throw e;
      }
    }

    this.deviceId = deviceId;
    this.emit('register', deviceId);
  }
}
