import {
  NexxusVolatileTransportWorker,
  NexxusVolatileTransportWorkerConfig
} from "./VolatileTransportWorker";
import { NexxusBaseWorkerEvents, NexxusWorkerServices } from "../BaseWorker";
import { NexxusWsClient } from './ws/Client';
import {
  NexxusWsInternalServerException,
  NexxusWsInvalidParametersException
} from './ws/Exceptions';

import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusQueueName,
  NexxusTransportWorkerPayload
} from '@mayhem93/nexxus-core-lib';
import { RedisDeviceInvalidParamsException } from '@mayhem93/nexxus-redis';

import * as path from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

export type NexxusWebsocketsTransportWorkerConfig = NexxusVolatileTransportWorkerConfig & {
  name: string;
  port: number;
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

export class NexxusWebsocketsTransportWorker extends NexxusVolatileTransportWorker<
  NexxusWebsocketsTransportWorkerConfig,
  NexxusWebsocketsTransportWorkerEvents
> {
  protected queueName : NexxusQueueName = "websockets-transport";
  protected static loggerLabel: Readonly<string> = "NxxWebsocketsTransportWorker";
  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];
  protected static schemaPath: string = path.join(__dirname, "../../../src/schemas/websockets-transport-worker.schema.json");

  private server! : WebSocketServer;
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
      this.server.once('listening', () => {
        NexxusWebsocketsTransportWorker.logger.info(
          `WebSocket server listening on port ${this.config.port}`,
          NexxusWebsocketsTransportWorker.loggerLabel
        );
        resolve();
      });

      this.server.once('error', reject);
    });

    this.server.on('connection', this.handleConnection.bind(this));
  }

  protected async sendToDevice(deviceId: string, data: NexxusTransportWorkerPayload['data']): Promise<void> {
    const client = this.registeredClients.get(deviceId);

    if (!client) {
      NexxusWebsocketsTransportWorker.logger.info(
        `No registered client found for device ID: "${deviceId}"`,
        { deviceId },
        NexxusWebsocketsTransportWorker.loggerLabel
      );

      return;
    }

    switch (data.event) {
      case 'model_created':
      case 'model_updated':
      case 'model_deleted':

        client.sendMessage(data.event, data);
        break;

      default:
        NexxusWebsocketsTransportWorker.logger.warn(
          `Unknown event type in payload: for device ID: "${deviceId}"`,
          { data, deviceId },
          NexxusWebsocketsTransportWorker.loggerLabel
        );
    }
  }

  private handleConnection(ws: WebSocket): void {
    const clientId = crypto.randomUUID();
    const client = new NexxusWsClient(clientId, ws);

    NexxusWebsocketsTransportWorker.logger.info(`New client connected with ID: "${clientId}"`,
      { clientId },
      NexxusWebsocketsTransportWorker.loggerLabel
    );

    this.wsToNexxusClientMap.set(ws, client);
    this.unregisteredClients.add(client);

    client.once('register', async deviceId => {
      try {
        await this.registerDevice(deviceId);

        this.unregisteredClients.delete(client);
        this.registeredClients.set(deviceId, client);
        client.sendMessage('register', { success: true });

        NexxusWebsocketsTransportWorker.logger.info(`Client "${clientId}" registered with device ID: "${deviceId}"`,
          { deviceId, clientId },
          NexxusWebsocketsTransportWorker.loggerLabel
        );
      } catch (e : Error | unknown) {
        if (e instanceof RedisDeviceInvalidParamsException) {
          client.sendError(new NexxusWsInvalidParametersException(`Invalid parameters for device with ID "${deviceId}": ${e.message}`));
        } else {
          client.sendError(new NexxusWsInternalServerException('An unexpected error occurred while registering the device.'));

          NexxusWebsocketsTransportWorker.logger.error(`Unexpected error during client registration for device ID "${deviceId}"`, { error: e, deviceId }, NexxusWebsocketsTransportWorker.loggerLabel);
        }
      }
    });

    ws.on('close', ((code: number, reason: Buffer) => {
      this.handleDisconnect(ws, code, reason);
    }).bind(this));
  }

  private async handleDisconnect(ws: WebSocket, code: number, reason: Buffer): Promise<void> {
    NexxusWebsocketsTransportWorker.logger.debug('Handling client disconnect...', NexxusWebsocketsTransportWorker.loggerLabel);

    const nxxWsClient = this.wsToNexxusClientMap.get(ws);
    let deviceId : string | undefined;

    try {
      if (!nxxWsClient) {
        return;
      }

      deviceId = nxxWsClient.getDeviceId();

      if (deviceId) {
        this.registeredClients.delete(deviceId);
        await this.unregisterDevice(deviceId);
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
    } catch (e) {
      if (e instanceof RedisDeviceInvalidParamsException) {
        NexxusWebsocketsTransportWorker.logger.error(`Error updating device on disconnect for device ID "${deviceId}"`, { error: e }, NexxusWebsocketsTransportWorker.loggerLabel);
      } else {
        NexxusWebsocketsTransportWorker.logger.error('Unexpected error on client disconnect', { error: e }, NexxusWebsocketsTransportWorker.loggerLabel);
      }
    }
  }
}
