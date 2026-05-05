import {
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusBaseService,
  INexxusBaseServices,
  NexxusBaseLogger,
  NexxusConfig,
  NexxusApplication,
  MODEL_REGISTRY,
  FatalErrorException,
  INexxusUser
} from '@mayhem93/nexxus-core-lib';
import {
  NexxusDatabaseAdapter,
  NexxusDatabaseAdapterEvents,
} from '@mayhem93/nexxus-database-lib';
import {
  NexxusMessageQueueAdapter,
  NexxusMessageQueueAdapterEvents,
} from '@mayhem93/nexxus-message-queue-lib';
import {
  NexxusRedis
} from '@mayhem93/nexxus-redis';
import {
  RootRoute,
  ApplicationRoute,
  DeviceRoute,
  UserRoute,
  SubscriptionRoute,
  ModelRoute
} from './routes';
import {
  NotFoundMiddleware,
  ErrorMiddleware,
  RequestLoggerMiddleware,
  RequiredHeadersMiddleware
} from './middlewares';
import {
  NexxusAuthStrategy,
  NexxusBaseAuthStrategyConfig,
  NexxusLocalAuthStrategy,
  NexxusGoogleAuthStrategy,
  NexxusAuthProviders
} from './auth';

import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { IncomingHttpHeaders, Server as HttpServer } from 'node:http';
import https from 'node:https';

import Express from 'express';
import helmet from 'helmet';
import passport from 'passport';

export type NexxusApiHeaders = {
  'nxx-app-id'?: Readonly<string>;
  'nxx-device-id'?: Readonly<string>;
};

export interface NexxusApiRequest extends Express.Request {
  headers: NexxusApiHeaders & IncomingHttpHeaders;
  user?: NexxusApiUser;
}

export type NexxusApiUser = Pick<INexxusUser, | 'username' | 'userType' | 'authProviders' | 'details' | 'appId'> & {
  id: string;
  iat?: number;
  exp?: number;
  aud?: string;
  iss?: string;
}

export interface NexxusApiResponse extends Express.Response {}

type NexxusApiConfig = {
  name: string;
  port: number;
  ssl?: {
    sslKeyPath: string;
    sslCertPath: string;
  };
  auth?: {
    jwtSecret: string;
    jwtExpiresIn: string;
    strategies: {
      [strategyName: NexxusAuthProviders]: NexxusBaseAuthStrategyConfig;
    };
  }
} & NexxusConfig;

interface ApiServices extends INexxusBaseServices {
  database: NexxusDatabaseAdapter<NexxusConfig, NexxusDatabaseAdapterEvents>;
  messageQueue: NexxusMessageQueueAdapter<NexxusConfig, NexxusMessageQueueAdapterEvents>;
  redis: NexxusRedis;
};

export class NexxusApi extends NexxusBaseService<NexxusApiConfig> {
  public static logger: NexxusBaseLogger<any>;
  public static database: NexxusDatabaseAdapter<NexxusConfig, NexxusDatabaseAdapterEvents>;
  public static messageQueue: NexxusMessageQueueAdapter<NexxusConfig, NexxusMessageQueueAdapterEvents>;
  public static redis: NexxusRedis;
  public static instance: NexxusApi;

  protected static cliArgs: ConfigCliArgs = {
    source: this.name,
    specs: []
  };
  protected static envVars: ConfigEnvVars = {
    source: this.name,
    specs: [
      {
        name: "AUTH_JWT_SECRET",
        location: "app.auth.jwtSecret"
      }
    ]
  };
  protected static schemaPath: string = path.join(__dirname, '../../src/schemas/api.schema.json');

  private express: Express.Express;
  private httpsServer?: https.Server;
  private authStrategies: Set<NexxusAuthStrategy> = new Set();
  private static readonly loadedApps: Map<string, NexxusApplication> = new Map();
  private static loggerLabel: Readonly<string> = 'NxxApi';

  constructor(services: ApiServices) {
    super(services.configManager.getConfig('app') as NexxusApiConfig);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new FatalErrorException('Logger service is not an instance of NexxusBaseLogger');
    }
    if (!(services.database instanceof NexxusDatabaseAdapter)) {
      throw new FatalErrorException('Database service is not an instance of NexxusDatabaseAdapter');
    }
    if (!(services.messageQueue instanceof NexxusMessageQueueAdapter)) {
      throw new FatalErrorException('Message Queue service is not an instance of NexxusMessageQueueAdapter');
    }
    if (!(services.redis instanceof NexxusRedis)) {
      throw new FatalErrorException('Redis service is not an instance of NexxusRedis');
    }

    NexxusApi.logger = services.logger;
    NexxusApi.database = services.database;
    NexxusApi.messageQueue = services.messageQueue;
    NexxusApi.redis = services.redis;

    this.express = Express();
    this.express.disable("x-powered-by");

    if (this.config.ssl !== undefined) {
      this.httpsServer = https.createServer({
        key: readFileSync(this.config.ssl.sslKeyPath),
        cert: readFileSync(this.config.ssl.sslCertPath)
      }, this.express);
    }

    NexxusApi.instance = this;
  }

  public async init(): Promise<void> {
    NexxusApi.logger.info('Initializing API service...', NexxusApi.loggerLabel);

    this.express.use(RequestLoggerMiddleware as Express.RequestHandler);
    this.express.use(helmet({
      xDownloadOptions: false,
      xXssProtection: false,
      xDnsPrefetchControl: false,
      xFrameOptions: false,
      originAgentCluster: false,
      referrerPolicy: { policy: 'same-origin' },
      strictTransportSecurity: this.config.ssl !== undefined ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      } : false
    }));
    this.express.use(Express.json());
    this.express.use(Express.urlencoded({ extended: true }));

    await this.loadApps();

    new RootRoute(this.express);

    if (this.config.auth !== undefined) {
      this.express.use(passport.initialize());

      for (const strategyName of Object.keys(this.config.auth.strategies)) {
        switch (strategyName as NexxusAuthProviders) {
          case 'local':
            this.addAuthStrategy(new NexxusLocalAuthStrategy());

            break;

          case 'google':
            this.addAuthStrategy(new NexxusGoogleAuthStrategy());

            break;

          default:
            NexxusApi.logger.warn(
              `Unknown auth strategy in config: ${strategyName}`,
              NexxusApi.loggerLabel
            );

            break;
        }
      }

      this.initializeAuthStrategies();
    }

    new ApplicationRoute(this.express);
    new DeviceRoute(this.express);
    new UserRoute(this.express);
    new SubscriptionRoute(this.express);
    new ModelRoute(this.express);

    this.express.use(NotFoundMiddleware);
    this.express.use(ErrorMiddleware);

    let server: HttpServer | https.Server;

    if (this.config.ssl !== undefined && this.httpsServer) {
      server = this.httpsServer;

      this.httpsServer.listen(this.config.port);
    } else {
      server = this.express.listen(this.config.port);
    }

    server.on('listening', () => {
      NexxusApi.logger.info(`API service is listening on port ${this.config.port}`, NexxusApi.loggerLabel);
    });
  }

  public getConfig(): NexxusApiConfig {
    return this.config;
  }

  public hasAuthStrategy(strategyName: NexxusAuthProviders): boolean {
    return Array.from(this.authStrategies).some(strategy => strategy.name === strategyName);
  }

  public getAuthProviderConfig<T extends NexxusBaseAuthStrategyConfig = NexxusBaseAuthStrategyConfig>(strategyName: NexxusAuthProviders): T {
    const config = this.config.auth?.strategies[strategyName] as T | undefined;

    if (!config) {
      throw new FatalErrorException(`Auth strategy config not found for strategy: ${strategyName}`);
    }

    return config;
  }

  public getAllAuthConfigs(): { [strategyName: NexxusAuthProviders]: NexxusBaseAuthStrategyConfig } | undefined {
    return this.config.auth?.strategies;
  }

  private addAuthStrategy(strategy: NexxusAuthStrategy): void {
    if (!(strategy instanceof NexxusAuthStrategy)) {
      throw new FatalErrorException(`Auth strategy is not an instance of NexxusAuthStrategy`);
    }

    if (this.authStrategies.has(strategy)) {
      NexxusApi.logger.warn(
        `Auth strategy already added: ${strategy.name}`,
        NexxusApi.loggerLabel
        );

        return ;
    }

    this.authStrategies.add(strategy);
  }

  public getAuthStrategy(strategyName: NexxusAuthProviders): NexxusAuthStrategy {
    const strategy = Array.from(this.authStrategies).find(s => s.name === strategyName);

    if (!strategy) {
      throw new FatalErrorException(`Auth strategy not found: ${strategyName}`);
    }

    return strategy;
  }

  private initializeAuthStrategies(): void {
    for (const strategy of this.authStrategies) {
      // Initialize the Passport strategy
      strategy.initializePassport();

      // Register auth route: /auth/{strategy-name}
      this.express.post(
        `/auth/${strategy.name}`,
        RequiredHeadersMiddleware('nxx-app-id') as Express.RequestHandler,
        strategy.handleAuth.bind(strategy)
      );

      // Register callback route if strategy requires it
      if (strategy.requiresCallback) {
        this.express.get(
          `/auth/${strategy.name}/callback`,
          strategy.handleCallback.bind(strategy)
        );
      }

      NexxusApi.logger.debug(
        `Registered auth strategy: ${strategy.name}`,
        NexxusApi.loggerLabel
      );
    }
  }

  private async loadApps(): Promise<void> {
    const results = await NexxusApi.database.searchItems({ type: MODEL_REGISTRY.application });

    for (let app of results) {
      NexxusApi.loadedApps.set(app.getData().id as string, app);
    }

    NexxusApi.logger.info(`Loaded ${NexxusApi.loadedApps.size} applications into API service`, NexxusApi.loggerLabel);
  }

  public static getStoredApp(appId: string): NexxusApplication | undefined {
    return NexxusApi.loadedApps.get(appId);
  }
}
