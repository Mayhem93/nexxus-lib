import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusQueueName,
  NexxusTransportDeviceMessagePayload,
  InvalidTokenException,
  TokenExpiredException,
  SessionEndedException
} from '@mayhem93/nexxus-core-lib';
import { RedisDeviceInvalidParamsException, RedisKeyNotFoundException } from '@mayhem93/nexxus-redis';

import {
  NexxusVolatileTransportWorker,
  NexxusVolatileTransportWorkerConfig,
  NexxusVolatileTransportWorkerStats,
  type NexxusDeviceDisconnectReason
} from './VolatileTransportWorker';
import { NexxusBaseWorkerEvents, NexxusBaseWorkerStats, NexxusWorkerServices } from '../BaseWorker';
import { NexxusWorkerUnsupportedEventException } from '../Exceptions';
import { NexxusWsClient } from './ws/Client';
import {
  NexxusWsInternalServerException,
  NexxusWsInvalidParametersException,
  NexxusWsDeviceNotFoundException,
  NexxusWsTokenExpiredException,
  NexxusWsSessionEndedException
} from './ws/Exceptions';

import { WebSocketServer, type WebSocket } from 'ws';

import * as crypto from 'node:crypto';
import * as path from 'node:path';

export type NexxusWebsocketsTransportWorkerConfig = NexxusVolatileTransportWorkerConfig & {
  name: string;
  port: number;
  /** Seconds between pings to each connection. */
  heartbeatInterval?: number;
  /** Class name of the logger service (see `NexxusApiConfig.logger`). */
  logger: string;
  /** Class name of the database adapter (see `NexxusApiConfig.database`). */
  database: string;
  /** Class name of the message-queue adapter (see `NexxusApiConfig.message_queue`). */
  message_queue: string;
}

type NexxusWebsocketsTransportWorkerEvents = NexxusBaseWorkerEvents & {
  message: [string];
}

type NexxusWebsocketsTransportWorkerStats = NexxusVolatileTransportWorkerStats & {
  unregisteredClients: number;
  registeredClients: number;
  totalConnections: number;
}

export class NexxusWebsocketsTransportWorker extends NexxusVolatileTransportWorker<
  NexxusWebsocketsTransportWorkerConfig,
  NexxusWebsocketsTransportWorkerEvents,
  NexxusWebsocketsTransportWorkerStats
> {
  protected nodeRole: string = 'websockets-transport';
  protected queueName : NexxusQueueName = 'websockets-transport';
  protected static loggerLabel: Readonly<string> = 'NxxWebsocketsTransportWorker';
  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];
  protected static schemaPath: string = path.join(__dirname, '../../../src/schemas/websockets-transport-worker.schema.json');

  /**
   * WebSocket close codes for each reason a device is disconnected. The client
   * branches on the code: `logged_out` means don't reconnect; `token_expired`
   * means refresh, then reconnect; `service_restart` means reconnect after a
   * short random delay, so a node's clients don't all come back at once. The
   * first two are in the 4000–4999 range reserved for applications;
   * `service_restart` is the standard 1012. The reason string travels alongside
   * for traceability.
   */
  private static readonly CLOSE_CODES: Readonly<Record<NexxusDeviceDisconnectReason, number>> = {
    logged_out: 4001,
    token_expired: 4002,
    service_restart: 1012
  };

  /**
   * Code and reason a new connection is closed with while the slot queue is
   * lost: the standard 1013, try again later. The client backs off before
   * reconnecting.
   */
  private static readonly TRY_AGAIN_LATER = { code: 1013, reason: 'try_again_later' } as const;

  /** Seconds between pings when `heartbeatInterval` isn't configured. */
  private static readonly DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;

  /**
   * How long connections get to close cleanly when they are all ended at once,
   * before the ones still open are cut off. Leaves the rest of shutdown room
   * within a process manager's stop timeout, such as supervisord's default of
   * 10 seconds.
   */
  private static readonly DISCONNECT_ALL_GRACE_MS = 3_000;

  private server! : WebSocketServer;
  /**
   * Settles once the server has stopped and its last connection has ended,
   * with the error closing it raised, if any. Set by `stopAcceptingConnections`.
   */
  private serverClosed: Promise<Error | undefined> | null = null;
  /**
   * `disconnectAllDevices` calls waiting for the connections they ended to be
   * torn down, each with the ones still to go. Settled in `handleDisconnect`.
   */
  private teardownWaiters: Array<{ pending: Set<NexxusWsClient>; resolve: () => void }> = [];
  private unregisteredClients: Set<NexxusWsClient> = new Set();
  private registeredClients : Map<string, NexxusWsClient> = new Map(); // Map of deviceId to WebSocket client
  private wsToNexxusClientMap: Map<WebSocket, NexxusWsClient> = new Map();

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  protected async initTransport(): Promise<void> {
    this.server = new WebSocketServer({
      port: this.config.port,
      autoPong: true,
      perMessageDeflate: {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 1
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 2048
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onBindError = (err: Error) => reject(err);

      this.server.once('listening', () => {
        this.server.removeListener('error', onBindError);

        NexxusWebsocketsTransportWorker.logger.info(
          `WebSocket server listening on port ${this.config.port}`,
          NexxusWebsocketsTransportWorker.loggerLabel
        );
        resolve();
      });

      this.server.once('error', onBindError);
    });

    // The bind-time listener above is gone once we're listening. Without a
    // lasting one, a later server-level error would be an unhandled 'error'
    // event, which is fatal to the process.
    this.server.on('error', (err: Error) => {
      NexxusWebsocketsTransportWorker.logger.error(
        `WebSocket server error: ${err.message}`,
        { error: err },
        NexxusWebsocketsTransportWorker.loggerLabel
      );
    });

    this.server.on('connection', this.handleConnection.bind(this));
  }

  protected async sendToDevice(deviceId: string, data: NexxusTransportDeviceMessagePayload['data']): Promise<void> {
    const client = this.registeredClients.get(deviceId);

    if (!client) {
      // this happens when a device disconnects from transport while
      // the worker is still processing a message for it. In this case,
      // we just log and ignore the message.
      NexxusWebsocketsTransportWorker.logger.info(
        `No registered client found for device ID: "${deviceId}"`,
        { deviceId },
        NexxusWebsocketsTransportWorker.loggerLabel
      );

      return;
    }

    // Checked here, when there is something to deliver, rather than on a timer:
    // a well-behaved client refreshes its access token in place before expiry,
    // so this only ever catches one that didn't. It gets nothing past its
    // token's lifetime, and is disconnected with the reason.
    if (client.isTokenExpired()) {
      await this.disconnectDevice(deviceId, 'token_expired');

      return;
    }

    switch (data.event) {
      case 'model_created':
      case 'model_updated':
      case 'model_deleted':

        client.sendMessage(data.event, data);
        break;

      default:
        // Unreachable by type, reachable at runtime: a newer Transport Manager
        // can send an event this transport predates. It's the same event for
        // every device in the message, so the first device stops the whole one.
        throw new NexxusWorkerUnsupportedEventException(
          `The websockets transport doesn't deliver "${(data as { event: string }).event}" events`
        );
    }
  }

  protected disconnectDevice(deviceId: string, reason: NexxusDeviceDisconnectReason): Promise<void> {
    const client = this.registeredClients.get(deviceId);

    if (!client) {
      // Already gone — the client may have closed it at the same moment.
      NexxusWebsocketsTransportWorker.logger.debug(
        `No live connection to end for device ID: "${deviceId}" (${reason})`,
        { deviceId, reason },
        NexxusWebsocketsTransportWorker.loggerLabel
      );

      return Promise.resolve();
    }

    NexxusWebsocketsTransportWorker.logger.info(
      `Disconnecting device ID: "${deviceId}" (${reason})`,
      { deviceId, reason, clientId: client.id },
      NexxusWebsocketsTransportWorker.loggerLabel
    );

    // Only closes the socket. Teardown happens in `handleDisconnect`, the same
    // path as a client-initiated close, so it runs exactly once whoever closes
    // first.
    client.close(NexxusWebsocketsTransportWorker.CLOSE_CODES[reason], reason);

    return Promise.resolve();
  }

  protected stopAcceptingConnections(): void {
    // Never listened: `init()` stopped before the transport started.
    if (!this.server) {
      return;
    }

    // Resolves with the error rather than rejecting: `close()` only awaits it at
    // the very end, and a rejection left waiting that long counts as unhandled.
    this.serverClosed = new Promise<Error | undefined>(resolve => {
      this.server.close(err => resolve(err));
    });
  }

  protected async disconnectAllDevices(reason: NexxusDeviceDisconnectReason): Promise<void> {
    const clients = [ ...this.wsToNexxusClientMap.values() ];

    if (clients.length === 0) {
      return;
    }

    NexxusWebsocketsTransportWorker.logger.info(
      `Ending all ${clients.length} connection(s) (${reason})`,
      { reason, connections: clients.length },
      NexxusWebsocketsTransportWorker.loggerLabel
    );

    // Only these: a connection that arrives meanwhile isn't this call's to
    // wait for.
    const tornDown = this.waitUntilTornDown(clients);

    // Registered or not: a connection that hasn't registered yet is one more
    // client to tell.
    for (const client of clients) {
      client.close(NexxusWebsocketsTransportWorker.CLOSE_CODES[reason], reason);
    }

    // A client that hasn't closed its end by then is cut off. Its connection is
    // torn down all the same.
    const cutOff = setTimeout(() => {
      const open = clients.filter(client => !client.isClosed());

      if (open.length === 0) {
        return;
      }

      NexxusWebsocketsTransportWorker.logger.info(
        `Cutting off ${open.length} connection(s) still open after ${NexxusWebsocketsTransportWorker.DISCONNECT_ALL_GRACE_MS} ms`,
        { reason, connections: open.length },
        NexxusWebsocketsTransportWorker.loggerLabel
      );

      for (const client of open) {
        client.terminate();
      }
    }, NexxusWebsocketsTransportWorker.DISCONNECT_ALL_GRACE_MS);

    await tornDown;

    clearTimeout(cutOff);
  }

  /** Resolves once each of `clients`, all of them connected now, has been torn down. */
  private waitUntilTornDown(clients: NexxusWsClient[]): Promise<void> {
    return new Promise<void>(resolve => {
      this.teardownWaiters.push({ pending: new Set(clients), resolve });
    });
  }

  private handleConnection(ws: WebSocket): void {
    // Nothing would reach this connection while the slot queue is lost.
    if (this.isSlotQueueLost) {
      // A ws socket with no 'error' listener throws on one.
      ws.on('error', (err: Error) => {
        NexxusWebsocketsTransportWorker.logger.debug(
          `WebSocket error on a connection turned away: ${err.message}`,
          NexxusWebsocketsTransportWorker.loggerLabel
        );
      });

      ws.close(NexxusWebsocketsTransportWorker.TRY_AGAIN_LATER.code, NexxusWebsocketsTransportWorker.TRY_AGAIN_LATER.reason);

      NexxusWebsocketsTransportWorker.logger.debug(
        'Turned a connection away: the slot queue is lost',
        NexxusWebsocketsTransportWorker.loggerLabel
      );

      return;
    }

    const clientId = crypto.randomUUID();
    const heartbeatInterval = this.config.heartbeatInterval ?? NexxusWebsocketsTransportWorker.DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
    const client = new NexxusWsClient(clientId, ws, heartbeatInterval * 1000);

    NexxusWebsocketsTransportWorker.logger.info(`New client connected with ID: "${clientId}"`,
      { clientId },
      NexxusWebsocketsTransportWorker.loggerLabel
    );

    this.wsToNexxusClientMap.set(ws, client);
    this.unregisteredClients.add(client);

    // The registration in flight on this connection, if any. The connection's
    // teardown waits for it: one that closed mid-registration would otherwise
    // find no device to tear down, and the registration would then record the
    // device as online here, with no connection behind it.
    let registration: Promise<void> = Promise.resolve();

    // `on`, not `once`: the client is only considered registered once
    // `handleRegister` has written the device's state, so a failed attempt has
    // to be retryable. The client's own in-flight guard is what stops a burst of
    // register frames.
    client.on('register', token => {
      registration = this.handleRegister(client, token);
    });

    // A registered connection moving onto a fresh access token without dropping:
    // the client got it from `/auth/refresh` and sends it here before the current
    // one expires. Verification is CPU-only; nothing here touches Redis.
    client.on('refresh_access_token', token => {
      // Non-null: the client only emits this once registered.
      const deviceId = client.getDeviceId()!;

      try {
        const expiresAt = this.authenticateRefreshedToken(token, deviceId, client.getAppId()!);

        client.confirmTokenRefresh(expiresAt);
        client.sendMessage('refresh_access_token', { success: true });
      } catch (e : Error | unknown) {
        // The connection keeps the token it had: a rejected refresh doesn't cut
        // it short, and the expiry check still ends it on time if no valid one
        // arrives.
        // No SESSION_ENDED here: a refresh never reads the session (no Redis),
        // and a logged-out device has its socket closed with 4001 instead.
        if (e instanceof TokenExpiredException) {
          client.sendError(new NexxusWsTokenExpiredException('Token has expired — refresh it and send it again.'));
        } else if (e instanceof InvalidTokenException) {
          client.sendError(new NexxusWsInvalidParametersException(`Invalid token: ${e.message}`));
        } else {
          client.sendError(new NexxusWsInternalServerException('An unexpected error occurred while refreshing the access token.'));

          NexxusWebsocketsTransportWorker.logger.error(
            `Unexpected error refreshing the access token of device ID "${deviceId}"`,
            { error: e, deviceId },
            NexxusWebsocketsTransportWorker.loggerLabel
          );
        }
      }
    });

    // A ws socket with no 'error' listener throws, which any client could
    // trigger with a malformed frame or an abrupt reset. 'close' follows an
    // error, so cleanup is left to handleDisconnect.
    ws.on('error', (err: Error) => {
      NexxusWebsocketsTransportWorker.logger.error(
        `WebSocket error for client "${clientId}": ${err.message}`,
        { clientId, error: err },
        NexxusWebsocketsTransportWorker.loggerLabel
      );
    });

    ws.on('close', (code: number, reason: Buffer) => {
      void registration.then(() => this.handleDisconnect(ws, code, reason));
    });
  }

  /**
   * Verify the token a connection registers with, and record the device it
   * names as online here. Never rejects, which the connection's teardown relies
   * on: a failure is answered on the connection, which stays unregistered and
   * free to try again.
   */
  private async handleRegister(client: NexxusWsClient, token: string): Promise<void> {
    let deviceId: string | undefined;

    try {
      // The device is a claim inside the token, not a value the client chose,
      // so a client can only ever register the device its own token names.
      const identity = await this.authenticateDevice(token);

      deviceId = identity.deviceId;

      await this.registerDevice(deviceId);

      this.unregisteredClients.delete(client);
      this.registeredClients.set(deviceId, client);
      client.confirmRegistration(deviceId, identity.appId, identity.expiresAt);
      client.sendMessage('register', { success: true });

      NexxusWebsocketsTransportWorker.logger.info(`Client "${client.id}" registered with device ID: "${deviceId}"`,
        { deviceId, clientId: client.id },
        NexxusWebsocketsTransportWorker.loggerLabel
      );
    } catch (e : Error | unknown) {
      // Leaves the client unregistered and free to try again.
      client.failRegistration();

      // TOKEN_EXPIRED and SESSION_ENDED get their own codes because they call
      // for different responses — refresh, versus start a new session — and
      // the client shouldn't have to parse a message to tell them apart.
      if (e instanceof TokenExpiredException) {
        // No reconnect needed: this socket stays open and `register` can be
        // sent again on it once the client holds a fresh token.
        client.sendError(new NexxusWsTokenExpiredException('Token has expired — refresh it and register again.'));
      } else if (e instanceof SessionEndedException) {
        client.sendError(new NexxusWsSessionEndedException(e.message));
      } else if (e instanceof InvalidTokenException) {
        client.sendError(new NexxusWsInvalidParametersException(`Invalid token: ${(e as Error).message}`));
      } else if (e instanceof RedisKeyNotFoundException) {
        // Structurally valid token for a device whose record is gone.
        client.sendError(new NexxusWsDeviceNotFoundException('The device this token was issued to no longer exists.'));
      } else if (e instanceof RedisDeviceInvalidParamsException) {
        client.sendError(new NexxusWsInvalidParametersException(`Invalid parameters for device with ID "${deviceId}": ${e.message}`));
      } else {
        client.sendError(new NexxusWsInternalServerException('An unexpected error occurred while registering the device.'));

        NexxusWebsocketsTransportWorker.logger.error(`Unexpected error during client registration for device ID "${deviceId}"`, { error: e, deviceId }, NexxusWebsocketsTransportWorker.loggerLabel);
      }
    }
  }

  private async handleDisconnect(ws: WebSocket, code: number, reason: Buffer): Promise<void> {
    NexxusWebsocketsTransportWorker.logger.debug('Handling client disconnect...', NexxusWebsocketsTransportWorker.loggerLabel);

    const nxxWsClient = this.wsToNexxusClientMap.get(ws);

    if (!nxxWsClient) {
      return;
    }

    const deviceId = nxxWsClient.getDeviceId();
    // The device may have registered again on this node before this socket's
    // close arrived. It belongs to the newer connection then, and so does its
    // teardown.
    const ownsDevice = deviceId !== undefined && this.registeredClients.get(deviceId) === nxxWsClient;

    // Only the Redis update can fail. Doing it first, on its own, keeps a
    // failure from skipping the local cleanup below — which would leak a client
    // reference per disconnect and drift `totalConnections` upward for good.
    try {
      if (ownsDevice) {
        await this.unregisterDevice(deviceId);
      }
    } catch (e) {
      if (e instanceof RedisDeviceInvalidParamsException) {
        NexxusWebsocketsTransportWorker.logger.error(`Error updating device on disconnect for device ID "${deviceId}"`, { error: e }, NexxusWebsocketsTransportWorker.loggerLabel);
      } else {
        NexxusWebsocketsTransportWorker.logger.error('Unexpected error on client disconnect', { error: e }, NexxusWebsocketsTransportWorker.loggerLabel);
      }
    }

    // Whether or not the Redis update worked: the socket is gone either way.
    if (ownsDevice) {
      this.registeredClients.delete(deviceId);
    } else if (deviceId) {
      NexxusWebsocketsTransportWorker.logger.debug(
        `Client "${nxxWsClient.id}" closed after a newer connection registered device ID "${deviceId}"; left the device to it`,
        { deviceId, clientId: nxxWsClient.id },
        NexxusWebsocketsTransportWorker.loggerLabel
      );
    } else {
      this.unregisteredClients.delete(nxxWsClient);
    }

    this.wsToNexxusClientMap.delete(ws);

    NexxusWebsocketsTransportWorker.logger.info(
      `Client "${nxxWsClient.id}" disconnected with device ID: "${deviceId || 'null'}. Code ${code}, Reason: "${reason.toString()}"`,
      {
        deviceId: deviceId || null,
        code,
        reason: reason.toString()
      },
      NexxusWebsocketsTransportWorker.loggerLabel
    );

    for (const waiter of this.teardownWaiters) {
      waiter.pending.delete(nxxWsClient);

      if (waiter.pending.size === 0) {
        waiter.resolve();
      }
    }

    this.teardownWaiters = this.teardownWaiters.filter(waiter => waiter.pending.size > 0);
  }

  public async close(): Promise<void> {
    await super.close();

    if (this.serverClosed) {
      const err = await this.serverClosed;

      if (err) {
        throw err;
      }

      NexxusWebsocketsTransportWorker.logger.info('WebSocket server closed', NexxusWebsocketsTransportWorker.loggerLabel);
    }
  }

  protected getOwnStats(): Promise<Omit<NexxusWebsocketsTransportWorkerStats, keyof NexxusBaseWorkerStats>> {
    return Promise.resolve({
      unregisteredClients: this.unregisteredClients.size,
      registeredClients: this.registeredClients.size,
      totalConnections: this.wsToNexxusClientMap.size
    });
  }
}
