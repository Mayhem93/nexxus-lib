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
  InvalidConfigException,
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
import {
  NotFoundException,
  InvalidParametersException
} from './Exceptions';

/**
 * Constructable type for `NexxusAuthStrategy` subclasses. Used to type the
 * per-name registry populated by `addAuthStrategy()` — the API stores classes
 * here and instantiates one per Application during init.
 *
 * Constructor args mirror `NexxusAuthStrategy`:
 *   - `config`        — per-strategy config from `app.auth.strategies[name]`
 *   - `appId`         — owning Application id (becomes part of the Passport
 *                       registration name so each tenant is isolated)
 *   - `jwtSecret`     — per-app JWT signing secret from `app.auth.jwtSecret`
 *   - `jwtExpiresIn?` — per-app JWT expiry, defaults to '7d' inside the base
 */
export type NexxusAuthStrategyCtor = {
  new (
    config: NexxusBaseAuthStrategyConfig,
    appId: string,
    jwtSecret: string,
    jwtExpiresIn?: string
  ): NexxusAuthStrategy;
  /** Class-level — true for OAuth-style strategies needing a `/callback` route. */
  readonly requiresCallback: boolean;
};

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
  /**
   * Auth at the deployment level is now just the list of strategy types this
   * API supports. Per-strategy config (clientID, clientSecret, etc.) and the
   * JWT secret live on each Application document — see `INexxusApplication.auth`.
   */
  auth?: {
    availableStrategies: string[];
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

  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];

  protected static configRootKey: string = "app";
  protected static schemaPath: string = path.join(__dirname, '../../src/schemas/api.schema.json');

  private express: Express.Express;
  private server : HttpServer | https.Server | null = null;
  private httpsServer?: https.Server;
  /**
   * Registry of auth strategy CLASSES, keyed by strategy name. Populated by
   * `addAuthStrategy()` before `init()`. Per-application strategy INSTANCES
   * are created lazily during init from these classes.
   */
  private authStrategyClasses: Map<string, NexxusAuthStrategyCtor> = new Map();
  /**
   * Per-application strategy instances, keyed by `${appId}|${strategyName}`.
   * Built by `setupAppAuthStrategies()` during `init()` after `loadApps()`.
   * Each instance was constructed with that app's per-strategy config, which
   * went through the strategy class's own AJV schema validation.
   */
  private appAuthStrategies: Map<string, NexxusAuthStrategy> = new Map();
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

    await this.loadAvailableStrategies();
    await this.loadApps();

    new RootRoute(this.express);

    // Cross-validation + per-app instantiation runs whether or not strategies
    // are registered — that's how an Application with `authEnabled: true` but
    // no available strategies trips a clear error instead of silently serving
    // requests it can't authenticate.
    this.setupAppAuthStrategies();

    if (this.authStrategyClasses.size > 0) {
      this.express.use(passport.initialize());
      this.registerAuthRoutes();
    }

    new ApplicationRoute(this.express);
    new DeviceRoute(this.express);
    new UserRoute(this.express);
    new SubscriptionRoute(this.express);
    new ModelRoute(this.express);

    this.express.use(NotFoundMiddleware);
    this.express.use(ErrorMiddleware);

    if (this.config.ssl !== undefined && this.httpsServer) {
      this.server = this.httpsServer;

      this.httpsServer.listen(this.config.port);
    } else {
      this.server = this.express.listen(this.config.port);
    }

    this.server?.on('listening', () => {
      NexxusApi.logger.info(`API service is listening on port ${this.config.port}`, NexxusApi.loggerLabel);
    });
  }

  public async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      NexxusApi.logger.info('API service has been closed', NexxusApi.loggerLabel);
    }
  }

  public getConfig(): NexxusApiConfig {
    return this.config;
  }

  public hasAuthStrategy(strategyName: NexxusAuthProviders): boolean {
    return this.authStrategyClasses.has(strategyName);
  }

  /**
   * Walks `config.auth.availableStrategies` and loads each strategy class
   * into the registry. The config IS the source of truth for which auth
   * strategies this deployment supports — there's no value in making the
   * consumer iterate it manually before calling `init()`.
   */
  private async loadAvailableStrategies(): Promise<void> {
    const availableStrategies = this.config.auth?.availableStrategies ?? [];

    for (const name of availableStrategies) {
      await this.addAuthStrategy(name);
    }
  }

  /**
   * Loads one auth strategy CLASS by name into the registry. Called from
   * `loadAvailableStrategies()` once per entry in `config.auth.availableStrategies`.
   *
   * Resolution:
   *   - `'local'` / `'google'` → built-in classes (no dynamic import).
   *   - anything else → `await import(name)`, expect the package to default-
   *     export (or be) a class extending `NexxusAuthStrategy`.
   *
   * Failures are wrapped in `InvalidConfigException` with an actionable
   * message so operators see "is it installed?" rather than `ERR_MODULE_NOT_FOUND`.
   */
  private async addAuthStrategy(name: string): Promise<void> {
    if (this.authStrategyClasses.has(name)) {
      NexxusApi.logger.warn(`Auth strategy already registered: ${name}`, NexxusApi.loggerLabel);

      return;
    }

    let StrategyCtor: NexxusAuthStrategyCtor;

    switch (name) {
      case 'local':
        StrategyCtor = NexxusLocalAuthStrategy as unknown as NexxusAuthStrategyCtor;

        break;

      case 'google':
        StrategyCtor = NexxusGoogleAuthStrategy as unknown as NexxusAuthStrategyCtor;

        break;

      default: {
        let mod: any;

        try {
          mod = await import(name);
        } catch (e) {
          throw new InvalidConfigException(
            `Auth strategy package "${name}" could not be loaded — make sure it's installed. Underlying error: ${(e as Error).message}`
          );
        }

        let Ctor: any;

        if (typeof mod.default === 'function') {
          Ctor = mod.default;
        } else if (typeof mod === 'function') {
          Ctor = mod;
        } else {
          throw new InvalidConfigException(
            `Could not find an auth strategy class in package "${name}". The package must default-export a class extending NexxusAuthStrategy.`
          );
        }

        if (!(Ctor.prototype instanceof NexxusAuthStrategy)) {
          throw new InvalidConfigException(
            `Auth strategy class from package "${name}" must extend NexxusAuthStrategy.`
          );
        }

        StrategyCtor = Ctor as NexxusAuthStrategyCtor;
      }
    }

    this.authStrategyClasses.set(name, StrategyCtor);
    NexxusApi.logger.info(`Registered auth strategy class: ${name}`, NexxusApi.loggerLabel);
  }

  /**
   * Lookup key for the per-application strategy cache. Composite of appId and
   * strategy name so the same strategy type (e.g. 'google') can have distinct
   * instances per tenant.
   */
  private static appAuthStrategyKey(appId: string, strategyName: string): string {
    return `${appId}|${strategyName}`;
  }

  /**
   * Registers `POST /auth/<name>` (and `GET /auth/<name>/callback` for OAuth-
   * style strategies) per registered strategy CLASS. One URL path per strategy
   * type — tenant scoping happens in the handler via header lookup.
   *
   * Handler dispatch:
   *   1. POST /auth/<name>          — `nxx-app-id` header → cache lookup →
   *                                   404 if absent → delegate to handleAuth
   *   2. GET  /auth/<name>/callback — appId from the OAuth `state` param
   *                                   (convention: "<appId>|<userType>") →
   *                                   cache lookup → 404 if absent → handleCallback
   *
   * Failure modes are thrown as `NexxusApiException`s (`NotFoundException`,
   * `InvalidParametersException`) and flow through the standard `ErrorMiddleware`
   * — same JSON shape and logging as every other route. Multi-tenant convention:
   * don't leak whether the app exists or whether the strategy is supported
   * deployment-wide, so an unconfigured (app, strategy) pair is a 404.
   */
  private registerAuthRoutes(): void {
    for (const [name, Ctor] of this.authStrategyClasses) {
      const requiresCallback = Ctor.requiresCallback;

      this.express.post(
        `/auth/${name}`,
        RequiredHeadersMiddleware('nxx-app-id') as Express.RequestHandler,
        (req, res, next) => {
          const appId = req.headers['nxx-app-id'] as string;
          const strategy = this.getAppAuthStrategy(appId, name);

          if (!strategy) {
            return next(new NotFoundException(`Auth strategy "${name}" is not available for this application`));
          }

          return strategy.handleAuth(req, res, next);
        }
      );

      if (requiresCallback) {
        this.express.get(`/auth/${name}/callback`, (req, res, next) => {
          // OAuth providers redirect here. The state param carries appId by
          // convention (e.g. Google's state is "<appId>|<userType>"). The
          // `nxx-app-id` header isn't available on callbacks because they
          // come from the provider's redirect, not from the client.
          const state = req.query.state as string | undefined;

          if (!state) {
            return next(new InvalidParametersException('Missing state parameter'));
          }

          const [appId] = state.split('|');
          const strategy = this.getAppAuthStrategy(appId, name);

          if (!strategy) {
            return next(new NotFoundException(`Auth strategy "${name}" is not available for this application`));
          }

          return strategy.handleCallback(req, res, next);
        });
      }

      NexxusApi.logger.debug(`Registered auth route: /auth/${name}${requiresCallback ? ' (+callback)' : ''}`, NexxusApi.loggerLabel);
    }
  }

  /**
   * Per-application strategy instance, or `undefined` if the (appId, strategy)
   * pair isn't configured. Route handlers use this — `undefined` is
   * the signal to 404 the auth route for that tenant.
   */
  public getAppAuthStrategy(appId: string, strategyName: string): NexxusAuthStrategy | undefined {
    return this.appAuthStrategies.get(NexxusApi.appAuthStrategyKey(appId, strategyName));
  }

  /**
   * Validates per-app auth wiring and instantiates the strategy objects.
   * Called from `init()` after `loadAvailableStrategies()` and `loadApps()`.
   *
   * Validation:
   *   - Every app with `authEnabled: true` must declare each of its strategy
   *     keys within `availableStrategies` (an app can't reach for a strategy
   *     the deployment doesn't support).
   *
   *   (The reverse — every `availableStrategies` entry having a class — is
   *   already guaranteed by `loadAvailableStrategies()`; an unloadable name
   *   throws there with an actionable error.)
   *
   * Instantiation:
   *   - For each (app, strategy) pair, construct the strategy with that app's
   *     per-strategy config. The strategy base class's AJV validation fires
   *     in the constructor — any malformed config throws here, at startup.
   *   - Cached by `${appId}|${strategyName}` for route handler lookups.
   *
   * Any failure is fatal — the API refuses to start with inconsistent auth
   * config rather than serving requests with surprises.
   */
  private setupAppAuthStrategies(): void {
    const availableStrategies = this.config.auth?.availableStrategies ?? [];

    for (const [appId, app] of NexxusApi.loadedApps) {
      if (!app.hasAuthEnabled()) {
        continue;
      }

      const appAuth = app.getData().auth;

      // Defensive — the Application constructor enforces this on construction,
      // so reaching here means an Application was built via a path that bypassed it.
      if (!appAuth) {
        throw new FatalErrorException(
          `Application "${appId}" has authEnabled=true but no auth block. Fix the document and restart.`
        );
      }

      for (const [strategyName, strategyConfig] of Object.entries(appAuth.strategies)) {
        if (!availableStrategies.includes(strategyName)) {
          throw new FatalErrorException(
            `Application "${appId}" declares auth strategy "${strategyName}" but it is not in api.auth.availableStrategies (${availableStrategies.join(', ') || 'empty'})`
          );
        }

        const StrategyCtor = this.authStrategyClasses.get(strategyName)!;
        const instance = new StrategyCtor(
          strategyConfig as NexxusBaseAuthStrategyConfig,
          appId,
          appAuth.jwtSecret,
          appAuth.jwtExpiresIn
        );

        // Wire passport.use(passportName, ...) for THIS instance. Each
        // strategy's `passportName` is `${name}:${appId}`, so two apps using
        // the same strategy type get isolated Passport registrations.
        instance.initializePassport();

        this.appAuthStrategies.set(NexxusApi.appAuthStrategyKey(appId, strategyName), instance);

        NexxusApi.logger.debug(
          `Instantiated auth strategy "${strategyName}" for application "${appId}"`,
          NexxusApi.loggerLabel
        );
      }
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
