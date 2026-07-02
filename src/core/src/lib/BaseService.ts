import type {
  ConfigEnvVars,
  ConfigCliArgs,
  AddJsonSchemaDefFuncArg,
  NexxusConfigManager
} from './ConfigManager';
import type { NexxusBaseLogger } from './Logger';
import { FatalErrorException } from './Exceptions';
import { NexxusConfig } from './ConfigProvider';

import { JSONSchema7 } from 'json-schema';

import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

export type EventMap = Record<string | symbol, any[]>;

export interface INexxusBaseServices {
  configManager: NexxusConfigManager;
  logger: NexxusBaseLogger<NexxusConfig>;
}

/**
 * Static-only shape of a Nexxus service class. Anything ConfigManager needs to
 * register a service's config lives here — `name` (for diagnostics), plus the
 * three static-config accessors. Constructor visibility is intentionally
 * absent, so classes that expose an async factory instead of a public
 * constructor (e.g. `WinstonNexxusLogger.create(...)`) still satisfy the type.
 *
 * All `NexxusBaseService` subclasses satisfy this structurally. Downstream code
 * writing custom services should type against this interface when passing
 * classes to `ConfigManager.validateServices(...)`.
 */
export interface NexxusServiceClass {
  readonly name: string;
  schema(): AddJsonSchemaDefFuncArg;
  envVarConfig(): ConfigEnvVars;
  cliArgConfig(): ConfigCliArgs;
}

/**
 * `NexxusServiceClass` + a public constructor. This is the default shape for
 * pluggable adapters — DB, MQ, most anything without async init. Consumers
 * `new Cls(services)` directly at the bootstrap site.
 *
 * If your adapter needs to await something before it's ready (dynamic
 * imports, remote fetches, warm-up connections), use
 * `NexxusFactoryServiceClass` instead — that's what `WinstonNexxusLogger`
 * does for dynamic transports.
 */
export interface NexxusConstructableServiceClass extends NexxusServiceClass {
  new (services: INexxusBaseServices): NexxusBaseService<any, any>;
}

/**
 * `NexxusServiceClass` + a static async factory. For adapters whose
 * initialization has to await something — dynamic imports, remote handshakes,
 * schema fetches. The class typically hides its constructor (private) so
 * consumers must go through `Cls.create(services)`.
 *
 * Currently used only for `WinstonNexxusLogger`. Most adapters are fine as
 * `NexxusConstructableServiceClass`; only reach for this when async init is
 * actually needed.
 */
export interface NexxusFactoryServiceClass extends NexxusServiceClass {
  create(services: INexxusBaseServices): Promise<NexxusBaseService<any, any>>;
}

function frozen(target: any, propertyKey: string) {
  Object.defineProperty(target, propertyKey, {
    value: Object.freeze(target[propertyKey]),
    writable: false,
    configurable: false
  });
}

class TypedEventEmitter<E> {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
  }

  on<K extends keyof E>(event: K, listener: (...payload: E[K] extends any[] ? E[K] : never) => void): this {
    this.emitter.on(event as string | symbol, listener);

    return this;
  }

  once<K extends keyof E>(event: K, listener: (...payload: E[K] extends any[] ? E[K] : never) => void): this {
    this.emitter.once(event as string | symbol, listener);

    return this;
  }

  off<K extends keyof E>(event: K, listener: (...payload: E[K] extends any[] ? E[K] : never) => void): this {
    this.emitter.off(event as string | symbol, listener);

    return this;
  }

  emit<K extends keyof E>(event: K, ...payload: E[K] extends any[] ? E[K] : never): boolean {
    return this.emitter.emit(event as string | symbol, ...payload);
  }
}

export abstract class NexxusBaseService<T extends NexxusConfig, Ev extends EventMap = {}> extends TypedEventEmitter<Ev> {
  @frozen
  protected config: Readonly<T>;

  protected static envVars: ConfigEnvVars;
  protected static cliArgs: ConfigCliArgs;
  /**
   * The top-level key under which this service's configuration sits in the merged
   * root config (e.g. "logger", "database", "redis", "app"). Required for every
   * concrete service — ConfigManager uses it as the property name when grafting
   * the service's schema definition into the root JSON Schema.
   */
  protected static configRootKey: string;
  protected static schemaPath: string;
  private static schemaContents: string;

  constructor(config: Readonly<T>) {
    super();

    this.config = config;
  }

  public static envVarConfig(): ConfigEnvVars {
    if (!this.envVars) {
      throw new FatalErrorException(`Env vars spec not set for ${this.name} class.`);
    }

    return this.envVars;
  }

  public static cliArgConfig(): ConfigCliArgs {
    if (!this.cliArgs) {
      throw new FatalErrorException(`CLI args spec not set for ${this.name} class.`);
    }

    return this.cliArgs;
  }

  public static schema(): AddJsonSchemaDefFuncArg {
    if (!this.schemaPath) {
      throw new FatalErrorException(`Schema path not set for ${this.name} class.`);
    }

    if (!this.configRootKey) {
      throw new FatalErrorException(`configRootKey not set for ${this.name} class. ` +
        'This static must declare the top-level key under which this service\'s config sits in the merged root config.');
    }

    if (!this.schemaContents) {
      this.schemaContents = fs.readFileSync(this.schemaPath, 'utf-8');
    }

    const definition: JSONSchema7 = JSON.parse(this.schemaContents);

    return {
      name: this.name,
      where: this.configRootKey,
      definition,
      required: true
    };
  }
}
