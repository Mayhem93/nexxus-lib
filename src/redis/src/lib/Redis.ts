import {
  NexxusConfig,
  ConfigEnvVars,
  ConfigCliArgs,
  NexxusBaseService,
  INexxusBaseServices,
  NexxusBaseLogger
} from '@mayhem93/nexxus-core-lib';

import * as Redis from 'redis';

import * as path from 'node:path';

type RedisEvents = {
  connect: [];
  disconnect: [];
  error: [Error];
}

export type NexxusRedisConfig = {
  host: string;
  port: number;
  user?: string;
  password?: string;
  cluster?: boolean;
} & NexxusConfig;

/**
 * Redis-specific stats. `connected` is a hard requirement — everything else
 * comes from parsing `INFO`, so we make them optional in case the format
 * changes or a field is missing.
 */
export type NexxusRedisStats = {
  id: string | 'unknown';
  connected: boolean;
  memoryUsedBytes?: number;
  connectedClients?: number;
  totalKeys?: number;
  usedCpuSys?: number;
  usedCpuUser?: number;
};

/**
 * Redis `INFO` output is a text blob with `# Section` headers and `key:value`
 * lines. We flatten it to a `key → value` map and let the caller pick fields.
 * Blank lines and section headers are skipped.
 */
function parseRedisInfo(info: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const line of info.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) {
      continue;
    }

    const sep = line.indexOf(':');

    if (sep > 0) {
      out[line.slice(0, sep)] = line.slice(sep + 1);
    }
  }

  return out;
}

function parseIntOrUndefined(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;

  const n = parseInt(s, 10);

  return Number.isNaN(n) ? undefined : n;
}

function parseFloatOrUndefined(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;

  const n = parseFloat(s);

  return Number.isNaN(n) ? undefined : n;
}

export class NexxusRedis extends NexxusBaseService<NexxusRedisConfig, RedisEvents, NexxusRedisStats> {
  private client: Redis.RedisClientType | Redis.RedisClusterType | null = null;

  protected static loggerLabel: Readonly<string> = 'NxxRedis';
  protected static configRootKey: string = "redis";
  protected static schemaPath: string = path.join(__dirname, "../../src/schemas/redis.schema.json");
  protected static envVars: ConfigEnvVars = [];
  protected static cliArgs: ConfigCliArgs = [];

  public static logger: NexxusBaseLogger<any>;
  public static instance: NexxusRedis;

  constructor(services: INexxusBaseServices) {
    super(services.configManager.getConfig('redis') as NexxusRedisConfig);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new Error('Logger service is not an instance of NexxusBaseLogger');
    }

    NexxusRedis.logger = services.logger;
    NexxusRedis.instance = this;
  }

  public getClient(): Redis.RedisClientType | Redis.RedisClusterType {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }

    return this.client;
  }

  async init(): Promise<void> {
    if (this.config.cluster) {
      this.client = Redis.createCluster({
        rootNodes: [
          {
            url: `redis://${this.config.host}:${this.config.port}`,
            username: this.config.user,
            password: this.config.password
          }
        ],
        useReplicas: true,
        RESP: 3,
        clientSideCache: {
          ttl: 5*60*1000, // 5 minutes
          maxEntries: 1000,
          evictPolicy: 'FIFO'
        }
      }) as unknown as Redis.RedisClusterType;
    } else {
      this.client = Redis.createClient({
        url: `redis://${this.config.host}:${this.config.port}`,
        username: this.config.user,
        password: this.config.password,
        RESP: 3,
        clientSideCache: {
          ttl: 5 * 60 * 1000, // 5 minutes
          maxEntries: 1000,
          evictPolicy: 'FIFO'
        },
        socket: {
          keepAlive: true
        }
      }) as unknown as Redis.RedisClientType;
    }

    this.client.on('end', () => {
      NexxusRedis.logger.info('Redis connection closed', NexxusRedis.loggerLabel);
      this.emit('disconnect');
    }).on('error', (err) => {
      NexxusRedis.logger.error(`Redis connection error: ${err.message}`, NexxusRedis.loggerLabel);
      this.emit('error', err);
      this.emit('disconnect');
    }).on('ready', () => {
      NexxusRedis.logger.info('Connected to redis', NexxusRedis.loggerLabel);
      this.emit('connect');
    });

    await this.client.connect();
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
  }

  /**
   * Uses Redis's `INFO` command (returns a multi-section text blob) plus
   * `DBSIZE` for the key count. Two RTTs, both cheap. Parses out just the
   * fields observability tooling actually wants — everything else in INFO
   * is dropped to keep the payload compact and stable.
   */
  async getStats(): Promise<NexxusRedisStats> {
    if (!this.client) {
      return { id: 'unknown', connected: false };
    }

    try {
      const info = await this.client.info();
      const totalKeys = await this.client.dbSize();
      const parsed = parseRedisInfo(typeof info === 'string' ? info : String(info));

      return {
        id: parsed.run_id ?? 'unknown',
        connected: true,
        memoryUsedBytes: parseIntOrUndefined(parsed.used_memory),
        connectedClients: parseIntOrUndefined(parsed.connected_clients),
        totalKeys: Number(totalKeys),
        usedCpuSys: parseFloatOrUndefined(parsed.used_cpu_sys),
        usedCpuUser: parseFloatOrUndefined(parsed.used_cpu_user),
      };
    } catch {
      return { id: 'unknown', connected: false };
    }
  }
}
