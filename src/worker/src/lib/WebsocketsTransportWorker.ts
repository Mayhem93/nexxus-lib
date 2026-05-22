import {
  NexxusBaseWorker,
  NexxusBaseWorkerEvents,
  NexxusWorkerServices
} from "./BaseWorker";
import { NexxusWsClient } from './ws/Client';
import {
  NexxusWsInternalServerException,
  NexxusWsInvalidParametersException
} from './ws/Exceptions';

import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusBaseQueuePayload,
  NexxusConfig,
  NexxusQueueName,
  NexxusWebsocketPayload
} from '@mayhem93/nexxus-core-lib';
import { NexxusQueueMessage } from '@mayhem93/nexxus-message-queue-lib';
import { NexxusDevice, RedisDeviceInvalidParamsException } from '@mayhem93/nexxus-redis';

import * as path from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

type NexxusWebsocketsTransportWorkerConfig = NexxusConfig & {
  name: string;
  port: number;
}

type NexxusWebsocketsTransportWorkerEvents = NexxusBaseWorkerEvents & {
  message: [string];
}

export class NexxusWebsocketsTransportWorker extends NexxusBaseWorker<NexxusWebsocketsTransportWorkerConfig, NexxusWebsocketsTransportWorkerEvents, NexxusWebsocketPayload> {
  protected queueName : NexxusQueueName = "websockets-transport";
  protected static loggerLabel: Readonly<string> = "NxxWebsocketsTransportWorker";
  protected static cliArgs: ConfigCliArgs = {
    source: this.name,
    specs: []
  };
  protected static envVars: ConfigEnvVars = {
    source: this.name,
    specs: []
  };
  protected static schemaPath: string = path.join(__dirname, "../../src/schemas/websockets-transport-worker.schema.json");

  private server! : WebSocketServer;
  private unregisteredClients: Set<NexxusWsClient> = new Set();
  private registeredClients : Map<string, NexxusWsClient> = new Map(); // Map of deviceId to WebSocket client
  private wsToNexxusClientMap: Map<WebSocket, NexxusWsClient> = new Map();

  constructor(services: NexxusWorkerServices) {
    super(services);
  }

  public async init() : Promise<void> {
    if (this.initialized) {
      NexxusWebsocketsTransportWorker.logger.warn("NexxusWebsocketsTransportWorker already initialized", NexxusWebsocketsTransportWorker.loggerLabel);

      return Promise.resolve();
    }

    // TODO: Support multiple workers with IDs
    this.queueName += `_${this.config.workerId || 1}`;

    await super.init();

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
        NexxusWebsocketsTransportWorker.logger.info(`WebSocket server listening on port ${this.config.port}`, NexxusWebsocketsTransportWorker.loggerLabel);
        resolve();
      });

      this.server.once('error', reject);
    });

    this.server.on('connection', this.handleConnection.bind(this));
  }

  protected async processMessage(msg: NexxusQueueMessage<NexxusWebsocketPayload>): Promise<void> {
    NexxusWebsocketsTransportWorker.logger.debug('Processing message', { payload: msg.payload }, NexxusWebsocketsTransportWorker.loggerLabel);

    const payload = msg.payload;

    switch (payload.event) {
      case "device_message":
        NexxusWebsocketsTransportWorker.logger.debug("Received device_message event", NexxusWebsocketsTransportWorker.loggerLabel);

        if (payload.deviceIds.length === 0) {
          NexxusWebsocketsTransportWorker.logger.warn("No device IDs provided in device_message payload", NexxusWebsocketsTransportWorker.loggerLabel);

          return;
        }

        for (const deviceId of payload.deviceIds) {
          const client = this.registeredClients.get(deviceId);

          if (client) {
            switch (payload.data.event) {
              case 'model_created':
                NexxusWebsocketsTransportWorker.logger.debug(`Sending model_created to device ID: "${deviceId}"`, { deviceId }, NexxusWebsocketsTransportWorker.loggerLabel);

                client.sendMessage('model_created', payload.data);

                break;
              case 'model_updated':
                NexxusWebsocketsTransportWorker.logger.debug(`Sending model_updated to device ID: "${deviceId}"`, { deviceId }, NexxusWebsocketsTransportWorker.loggerLabel);

                client.sendMessage('model_updated', payload.data);

                break;

              case 'model_deleted':
                NexxusWebsocketsTransportWorker.logger.debug(`Sending model_deleted to device ID: "${deviceId}"`, { deviceId }, NexxusWebsocketsTransportWorker.loggerLabel);

                client.sendMessage('model_deleted', payload.data);

                break;

              default:
                NexxusWebsocketsTransportWorker.logger.warn(`Unknown event "${(payload.data as NexxusBaseQueuePayload).event}"`, { deviceId }, NexxusWebsocketsTransportWorker.loggerLabel);
            }
          } else {
            NexxusWebsocketsTransportWorker.logger.warn(`No registered client found for device ID: "${deviceId}"`, { deviceId }, NexxusWebsocketsTransportWorker.loggerLabel);
          }
        }

        break;
      default:
        NexxusWebsocketsTransportWorker.logger.warn(`Unknown event type: ${payload.event}`, NexxusWebsocketsTransportWorker.loggerLabel);
    }
  }

  private handleConnection(ws: WebSocket): void {
    const clientId = crypto.randomUUID();
    const client = new NexxusWsClient(clientId, ws);

    NexxusWebsocketsTransportWorker.logger.info(`New client connected with ID: "${clientId}"`, NexxusWebsocketsTransportWorker.loggerLabel);

    this.wsToNexxusClientMap.set(ws, client);
    this.unregisteredClients.add(client);

    client.once('register', async deviceId => {
      try {
        await NexxusDevice.update(deviceId, { lastSeen: new Date(), type: 'volatile', connectedTo: this.queueName, status: 'online' });

        this.unregisteredClients.delete(client);
        this.registeredClients.set(deviceId, client);
        client.sendMessage('register', { success: true });

        NexxusWebsocketsTransportWorker.logger.info(`Client "${clientId}" registered with device ID: "${deviceId}"`, NexxusWebsocketsTransportWorker.loggerLabel);
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

        await NexxusDevice.removeAllSubscriptions(deviceId);
        await NexxusDevice.update(deviceId, { lastSeen: new Date(), connectedTo: null, status: 'offline' });
      } else {
        this.unregisteredClients.delete(nxxWsClient);
      }

      this.wsToNexxusClientMap.delete(ws);

      NexxusWebsocketsTransportWorker.logger.info(
        `Client "${nxxWsClient.id}" disconnected with device ID: "${deviceId || 'null'}. Code ${code}, Reason: "${reason.toString()}"`,
        { deviceId, code, reason: reason.toString() },
        NexxusWebsocketsTransportWorker.loggerLabel
      );
    } catch (e) {
      if (e instanceof RedisDeviceInvalidParamsException) {
        NexxusWebsocketsTransportWorker.logger.error(`Error updating device on disconnect for device ID "${deviceId}"`, { error: e, deviceId }, NexxusWebsocketsTransportWorker.loggerLabel);
      } else {
        NexxusWebsocketsTransportWorker.logger.error('Unexpected error on client disconnect', { error: e, deviceId }, NexxusWebsocketsTransportWorker.loggerLabel);
      }
    }
  }
}
