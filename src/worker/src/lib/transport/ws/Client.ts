import {
  NexxusWsException,
  NexxusWsInvalidParametersException,
  NexxusWsInternalServerException
} from './Exceptions';
// `NexxusBaseWorker.logger` and `NexxusWebsocketsTransportWorker.logger` are the
// same static — reaching it through the base avoids importing the concrete
// worker, which imports this module in turn.
import { NexxusBaseWorker } from '../../BaseWorker';

import {
  NexxusTransportModelCreatedPayload,
  NexxusTransportModelDeletedPayload,
  NexxusTransportModelUpdatedPayload
} from '@mayhem93/nexxus-core-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';

import { WebSocket, Data as WebSocketData } from 'ws';

import { EventEmitter } from 'node:events';

export type ClientEventMap = {
  /**
   * Carries the raw token, which the worker verifies and resolves the device
   * from, and the id of the connection the client lost, if it named one.
   */
  register: [ token: string, lostConnectionId: string | undefined ];
  /** Carries a fresh access token for an already-registered connection. */
  refresh_access_token: [ token: string ];
}

export interface NexxusWsBaseEvent {
  event: string;
  data: any;
}

// Client → Server events
export type NexxusWsClientMessage = {
  register: {
    /**
     * The token the API issued. The device id is a claim inside it rather than
     * a field the client chooses, so a client can only ever register the device
     * its own token was issued to.
     */
    token: string;
    /**
     * After a close the client didn't ask for, the id of the connection it
     * lost. That connection is torn down before this one opens.
     */
    previousConnectionId?: string;
  };
  refresh_access_token: {
    /**
     * A fresh access token from `/auth/refresh`, for the device this connection
     * registered as. Sent before the current one expires, so the connection
     * never has to drop and re-register to keep going.
     */
    token: string;
  };
  // Add more client events here
};

// Server → Client events
export type NexxusWsServerMessage = {
  register: {
    success: boolean;
    /** This connection's id: what `nxx-connection-id` carries on subscribe and unsubscribe. */
    connectionId: string;
  };
  refresh_access_token: {
    success: boolean;
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

// Helper types for type-safe messaging. Distributive over `E`, so the default is
// a discriminated union and a `switch` on `event` narrows `data` with it.
export type NexxusWsClientEvent<E extends keyof NexxusWsClientMessage = keyof NexxusWsClientMessage> = {
  [K in E]: { event: K; data: NexxusWsClientMessage[K] };
}[E];

export type NexxusWsServerEvent<E extends keyof NexxusWsServerMessage = keyof NexxusWsServerMessage> = {
  event: E;
  data: NexxusWsServerMessage[E];
};

export class NexxusWsClient extends EventEmitter<ClientEventMap> {
  private socket : WebSocket;
  private deviceId?: string;
  /** The application the registering token named. A refreshed token must name the same one. */
  private appId?: string;
  /**
   * `exp` of the token this connection currently rests on, in UNIX seconds. Set
   * at registration and moved forward by each token refresh; nothing is delivered past
   * it.
   */
  private tokenExpiresAt?: number;
  /** True between emitting `register` and the worker confirming or failing it. */
  private registering: boolean = false;
  /**
   * Whether the client answered the last ping. Each ping clears it and the
   * pong sets it again; browsers send that pong on their own.
   */
  private answeredPing: boolean = true;
  /** Calls `heartbeat` every heartbeat interval, until the connection closes. */
  private readonly heartbeatTimer: NodeJS.Timeout;
  public readonly id: string;

  constructor(clientId: string, ws: WebSocket, heartbeatIntervalMs: number) {
    super();

    this.socket = ws;
    this.id = clientId;

    this.socket.on('pong', () => {
      this.answeredPing = true;
    });

    this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatIntervalMs);

    // 'close' follows however the connection ends, so the timer never outlives it.
    this.socket.on('close', () => {
      clearInterval(this.heartbeatTimer);
    });

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

  public getAppId() : string | undefined {
    return this.appId;
  }

  /**
   * Whether the token this connection rests on has expired. False for a client
   * that hasn't registered — it has no token yet, and receives nothing anyway.
   */
  public isTokenExpired(): boolean {
    return this.tokenExpiresAt !== undefined && Math.floor(Date.now() / 1000) >= this.tokenExpiresAt;
  }

  /**
   * Called by the transport worker once the connection is open in Redis and
   * the client is actually routable. Registration is only true from here on:
   * see the note in `registerDevice`.
   */
  public confirmRegistration(deviceId: string, appId: string, tokenExpiresAt: number): void {
    this.deviceId = deviceId;
    this.appId = appId;
    this.tokenExpiresAt = tokenExpiresAt;
    this.registering = false;
  }

  /** Called by the transport worker once a refreshed access token has been verified. */
  public confirmTokenRefresh(tokenExpiresAt: number): void {
    this.tokenExpiresAt = tokenExpiresAt;
  }

  /**
   * Close the connection with a code and reason the client can act on.
   * Idempotent: a socket already closing or closed — the client may be closing
   * it at the same moment — is left alone.
   */
  public close(code: number, reason: string): void {
    if (this.socket.readyState === WebSocket.CLOSING || this.socket.readyState === WebSocket.CLOSED) {
      return;
    }

    this.socket.close(code, reason);
  }

  /** Whether the connection has finished closing. */
  public isClosed(): boolean {
    return this.socket.readyState === WebSocket.CLOSED;
  }

  /** End the connection at once, without waiting for the client to answer a close. */
  public terminate(): void {
    this.socket.terminate();
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
        case 'refresh_access_token':
          this.refreshAccessToken(message);

          break;
        default:
          // Unreachable by type, reachable at runtime: the frame came off the
          // wire, and a client can name any event it likes.
          NexxusBaseWorker.logger.warn(`Unknown client event: ${(message as NexxusWsBaseEvent).event}`, 'NexxusWsClient');
      }
    } catch (e : unknown) {
      const err = e instanceof NexxusWsException
        ? e
        : new NexxusWsInternalServerException(`An unexpected error occurred while processing the message: ${e instanceof Error ? e.message : String(e)}`);

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
   * Ping the client, or end the connection when it never answered the previous
   * ping. A device that disappears without closing, on a dropped network or a
   * laptop gone to sleep, leaves a socket that looks open until a write to it
   * fails. Terminating it emits 'close', so the worker tears the connection
   * down the usual way.
   */
  private heartbeat(): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!this.answeredPing) {
      NexxusBaseWorker.logger.info(
        `Client "${this.id}" stopped answering pings; ending its connection`,
        { clientId: this.id, deviceId: this.deviceId },
        'NexxusWsClient'
      );

      this.socket.terminate();

      return;
    }

    this.answeredPing = false;
    this.socket.ping();
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

  private registerDevice(msg: NexxusWsClientEvent<'register'>) {
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

    const { token, previousConnectionId } = msg.data;

    if (!token || typeof token !== 'string' || token.trim() === '') {
      throw new NexxusWsInvalidParametersException('Invalid or missing token.');
    }

    if (previousConnectionId !== undefined
      && (typeof previousConnectionId !== 'string' || !NexxusDevice.isValidConnectionId(previousConnectionId))) {
      throw new NexxusWsInvalidParametersException('Invalid previousConnectionId.');
    }

    this.registering = true;

    // From here the transport worker owns the whole handshake: it verifies the
    // token, resolves the device, writes the volatile-device state, and then
    // calls `confirmRegistration` (or `failRegistration`), either of which
    // clears the in-flight flag.
    //
    // The device is deliberately NOT recorded here. If it were, a failed
    // registration would leave this client believing it is registered while the
    // worker has no route to it — and every retry would be refused as "already
    // registered", stranding the device until it reconnects on its own.
    this.emit('register', token, previousConnectionId);
  }

  /**
   * Hand a refreshed access token to the worker, which verifies it and moves this
   * connection's expiry forward. Only a registered connection has a token to
   * refresh; before that, the client should register.
   */
  private refreshAccessToken(msg: NexxusWsClientEvent<'refresh_access_token'>) {
    if (!this.isRegistered()) {
      throw new NexxusWsInvalidParametersException('Register before refreshing the access token.');
    }

    const token = msg.data.token;

    if (!token || typeof token !== 'string' || token.trim() === '') {
      throw new NexxusWsInvalidParametersException('Invalid or missing token.');
    }

    this.emit('refresh_access_token', token);
  }
}
