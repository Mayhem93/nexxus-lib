import {
  NexxusWsException,
  NexxusWsInvalidParametersException,
  NexxusWsInternalServerException,
  NexxusWsDeviceNotFoundException
} from './Exceptions';
// `NexxusBaseWorker.logger` and `NexxusWebsocketsTransportWorker.logger` are the
// same static — reaching it through the base avoids importing the concrete
// worker, which imports this module in turn.
import { NexxusBaseWorker } from '../../BaseWorker';

import { NexxusDevice, RedisKeyNotFoundException } from '@mayhem93/nexxus-redis';
import {
  NexxusTransportModelCreatedPayload,
  NexxusTransportModelDeletedPayload,
  NexxusTransportModelUpdatedPayload
} from '@mayhem93/nexxus-core-lib';

import { WebSocket, Data as WebSocketData } from 'ws';

import { EventEmitter } from 'node:events';

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
  /** True between emitting `register` and the worker confirming or failing it. */
  private registering: boolean = false;
  public readonly id: string;

  constructor(clientId: string, ws: WebSocket) {
    super();

    this.socket = ws;
    this.id = clientId;

    // Nothing in here may throw or reject: an unhandled rejection from a socket
    // listener takes the whole worker process down, and with it every other
    // device's live connection on this node. Any client could trigger that with
    // a single malformed frame, so the frame is parsed defensively and
    // processMessage's promise always carries a catch.
    this.socket.on('message', (msg: WebSocketData) => {
      let message: NexxusWsClientEvent;

      try {
        message = JSON.parse(msg.toString()) as NexxusWsClientEvent;
      } catch (e) {
        this.sendError(new NexxusWsInvalidParametersException(`Message is not valid JSON: ${(e as Error).message}`));

        return;
      }

      if (!message || typeof message !== 'object') {
        this.sendError(new NexxusWsInvalidParametersException('Message must be a JSON object.'));

        return;
      }

      if (!message.event) {
        this.sendError(new NexxusWsInvalidParametersException('Missing event type in message.'));

        return;
      }

      if (!message.data) {
        this.sendError(new NexxusWsInvalidParametersException('Missing data in message.'));

        return;
      }

      // processMessage handles its own errors; this is the backstop for what it
      // cannot (a socket that dies mid-reply).
      void this.processMessage(message).catch((e: unknown) => {
        NexxusBaseWorker.logger.error(
          `Unhandled error processing message from client "${this.id}"`,
          { error: e, clientId: this.id },
          'NexxusWsClient'
        );
      });
    });
  }

  public isRegistered() : boolean {
    return !!this.deviceId;
  }

  public getDeviceId() : string | undefined {
    return this.deviceId;
  }

  /**
   * Called by the transport worker once the device's Redis state is written and
   * the client is actually routable. Registration is only true from here on:
   * see the note in `registerDevice`.
   */
  public confirmRegistration(deviceId: string): void {
    this.deviceId = deviceId;
    this.registering = false;
  }

  /**
   * Called by the transport worker when the handshake it owns failed. The client
   * stays unregistered and is free to send another `register` frame.
   */
  public failRegistration(): void {
    this.registering = false;
  }

  public async processMessage(message: NexxusWsClientEvent) {
    try {
      switch (message.event) {
        case 'register':
          await this.registerDevice(message);

          break;
        default:
          NexxusBaseWorker.logger.warn(`Unknown client event: ${message.event}`, 'NexxusWsClient');
      }
    } catch (e : unknown) {
      let err = e as Error;

      if (!(e instanceof NexxusWsException)) {
        err = new NexxusWsInternalServerException(`An unexpected error occurred while processing the message: ${e instanceof Error ? e.message : String(e)}`);
      }

      NexxusBaseWorker.logger.error(`Error processing message from client "${this.id}"`, { error: err.message }, 'NexxusWsClient');
      this.sendError(err);
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

    this.send(errorMessage);
  }

  public sendMessage<E extends keyof NexxusWsServerMessage>(event: E, data: NexxusWsServerMessage[E]) {
    this.send({ event, data });

    NexxusBaseWorker.logger.info(`Sent ${event} message to client ${this.id}`,
      {
        clientId: this.id,
        deviceId: this.deviceId,
        event
      },
    'NexxusWsClient');
  }

  /**
   * `ws.send()` on a socket that is no longer OPEN doesn't throw — it emits
   * 'error' on the socket, which is fatal to the process if nothing is
   * listening. Losing a race with a disconnect is normal and not worth that, so
   * the state is checked up front and the message dropped.
   */
  private send(payload: unknown): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      NexxusBaseWorker.logger.debug(
        `Dropped a message for client "${this.id}" — socket is not open`,
        { clientId: this.id, deviceId: this.deviceId, readyState: this.socket.readyState },
        'NexxusWsClient'
      );

      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  private async registerDevice(msg: NexxusWsClientEvent<'register'>) {
    if (this.isRegistered()) {
      NexxusBaseWorker.logger.warn(`Client ${this.id} is already registered with device ID: "${this.deviceId}"`, 'NexxusWsClient');

      return ;
    }

    // Registration is only confirmed once the worker's Redis write lands, so
    // without this a client could pipeline a burst of register frames and have
    // every one of them hit Redis before the first was answered.
    if (this.registering) {
      NexxusBaseWorker.logger.warn(`Client ${this.id} already has a registration in flight`, 'NexxusWsClient');

      return ;
    }

    const deviceId = msg.data.deviceId;

    if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
      throw new NexxusWsInvalidParametersException('Invalid or missing deviceId.');
    }

    this.registering = true;

    try {
      await NexxusDevice.get(deviceId);
    } catch (e) {
      this.registering = false;

      if (e instanceof RedisKeyNotFoundException) {
        this.sendError(new NexxusWsDeviceNotFoundException(`Device with ID "${deviceId}" not found.`));

        return;
      }

      throw e;
    }

    // From here the transport worker owns the rest of the handshake: it writes
    // the volatile-device state and then calls `confirmRegistration` (or
    // `failRegistration`), either of which clears the in-flight flag.
    //
    // `deviceId` is deliberately NOT stored yet. If it were, a failed write
    // would leave this client believing it is registered while the worker has
    // no route to it — and every retry would be refused as "already
    // registered", stranding the device until it reconnects on its own.
    this.emit('register', deviceId);
  }
}
