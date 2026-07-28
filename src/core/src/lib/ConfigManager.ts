import { FatalErrorException, InvalidConfigException } from './Exceptions';
import { NexxusServiceClass } from './BaseService';
import {
  CliArgType,
  NexxusConfig,
  INexxusConfigProvider,
  NexxusConfigProvider,
  NexxusAsyncConfigProvider,
  NexxusFileConfigProvider,
  NexxusEnvVarsConfigProvider,
  NexxusCliArgConfigProvider
} from './ConfigProvider';
import { loadPackage } from './ServiceResolver';
import { WinstonNexxusLogger } from './Logger';

import { Ajv, ErrorObject } from 'ajv';
import * as Dot from 'dot-prop';
import deepMerge from 'deepmerge';
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';

import * as fs from "node:fs";
import * as path from "node:path";

type ConfigErrorObject = ErrorObject<string, Record<string, any>, unknown>[];

export type AddJsonSchemaDefFuncArg = {
  name: string;
  where: string;
  definition: JSONSchema7Definition;
  required: boolean;
}

type EnvVarsSpec = {
  name: string;
  /** Dot-notation path relative to the service's configRootKey (e.g. "host", "auth.jwtSecret"). */
  location: string;
};

export type ConfigEnvVars = Array<EnvVarsSpec>;

type CliArgsSpec = {
  name: string;
  /** Dot-notation path relative to the service's configRootKey. */
  location: string;
  type: CliArgType;
}

export type ConfigCliArgs = Array<CliArgsSpec>;

/**
 * Internal storage shape — wraps each service's env/CLI specs with the class name
 * (for collision diagnostics) and configRootKey (for resolving relative locations).
 */
type RegisteredSpecs<S> = {
  className: string;
  configRootKey: string;
  specs: S;
};

/**
 * One entry in the `NXX_CONFIG_PROVIDERS` env var — a custom config provider
 * to load out-of-band, before the rest of the config resolves. Deliberately
 * mirrors the shape of `WinstonNexxusLogger`'s custom-transport config:
 *   - `provider` — npm package specifier of the provider, resolved against the
 *                  app's install tree.
 *   - `export`  — optional named export to pick from the package; when absent
 *                 the default export (or the module-as-class for legacy CJS)
 *                 is used.
 *   - `options` — passthrough object handed to the provider's constructor.
 *                 This is the "extraneous config" a provider needs (e.g. an
 *                 AWS region + secret id) that CAN'T live in the Nexxus config
 *                 itself, because this provider is one of the things that
 *                 produces that config.
 */
export type CustomConfigProviderSpec = {
  provider: string;
  export?: string;
  options?: Record<string, unknown>;
};

export class NexxusConfigManager {
  private static CONF_FILE_NAME : Readonly<string> = 'nexxus.conf.json';
  private static DEFAULT_CONF_PATH : Readonly<string> = '/etc/nexxus';
  private static loggerLabel : Readonly<string> = 'NexxusConfigManager';
  /**
   * Special out-of-band env var carrying the JSON array of custom config
   * providers to load. Read directly (like `NXX_CONF_PATH`), NOT through
   * the regular env-var pipeline — the providers it names are part of what
   * produces the config, so their list must be available before config
   * resolution has run.
   */
  private static CONFIG_PROVIDERS_ENV_VAR : Readonly<string> = 'NXX_CONFIG_PROVIDERS';

  /**
   * Fallback/bootstrap logger — stdout, debug, json. Available immediately,
   * before any config resolves, so config-related issues can be logged.
   * Consumers (api/workers) may also use it for early bootstrap logging
   * before their real configured logger is resolved.
   */
  public readonly fallbackLogger: WinstonNexxusLogger;

  private jsonSchema: JSONSchema7;
  private envVarsSpecs: Array<RegisteredSpecs<ConfigEnvVars>> = [];
  private cliArgsSpecs: Array<RegisteredSpecs<ConfigCliArgs>> = [];
  private data: NexxusConfig = {};

  private configProviders : Array<INexxusConfigProvider> = [];
  private customProviders : Array<INexxusConfigProvider> = [];

  /**
   * Names (class.name) of services already registered. Guards against
   * double-registration when the same class is passed to `registerService`
   * or `validateServices` more than once — schema, env, and CLI specs each
   * carry a uniqueness invariant that would otherwise throw on a second pass.
   */
  private registeredServices: Set<string> = new Set();

  /**
   * True until the file + custom providers have been loaded into `this.data`
   * (i.e., first successful validate()). Subsequent validate() calls skip
   * re-reading the config file — the file is treated as immutable for the
   * lifetime of this ConfigManager.
   */
  private dataInitialized: boolean = false;

  /**
   * True when at least one service has been registered since the last
   * successful validate(). Lets `validateServices()` no-op cleanly when
   * called after everything's already been validated.
   */
  private hasNewRegistrations: boolean = false;

  constructor(configFilePath? : string) {
    this.fallbackLogger = WinstonNexxusLogger.createFallback();

    const schemaPath = path.join(__dirname, '../../src/schemas/root.schema.json');
    const resolvedConfPath = path.resolve(configFilePath || process.env.NXX_CONF_PATH || path.join(
      NexxusConfigManager.DEFAULT_CONF_PATH, NexxusConfigManager.CONF_FILE_NAME
    ));

    this.jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    this.configProviders.push(new NexxusFileConfigProvider(resolvedConfPath));
    this.configProviders.push(new NexxusEnvVarsConfigProvider());
    this.configProviders.push(new NexxusCliArgConfigProvider());
  }

  private addJsonSchemaDef(def: AddJsonSchemaDefFuncArg): void {
    //TODO: validate that jsonSchema is a valid json schema; eg try to ajv compile it

    if (this.jsonSchema.$defs !== undefined) {
      this.jsonSchema.$defs[def.name] = def.definition
    }

    if (this.jsonSchema.properties !== undefined) {
      this.jsonSchema.properties[def.where] = { "$ref": `#/$defs/${def.name}` } as JSONSchema7Definition;
    }

    if (def.required) {
      if (this.jsonSchema.required === undefined) {
        this.jsonSchema.required = [];
      }

      this.jsonSchema.required.push(def.where);
    }
  }

  /**
   * Register a service's config schema, env-var spec, and CLI-arg spec so
   * they're included in the next `validateServices()` pass. Idempotent per
   * class name — repeat calls with the same class are silent no-ops.
   *
   * Intended usage: call once per service class ahead of time (in any order),
   * then call `validateServices()` once to actually run validation. For the
   * shorthand where you know all services up front, `validateServices([...])`
   * still accepts an array and registers each entry before validating.
   */
  public registerService(svc: NexxusServiceClass): void {
    if (this.registeredServices.has(svc.name)) {
      return;
    }

    const schemaDef = svc.schema();
    const className = svc.name;
    const configRootKey = schemaDef.where;

    this.cliArgsSpecs.push({ className, configRootKey, specs: svc.cliArgConfig() });
    this.envVarsSpecs.push({ className, configRootKey, specs: svc.envVarConfig() });
    this.addJsonSchemaDef(schemaDef);
    this.registeredServices.add(className);
    this.hasNewRegistrations = true;
  }

  /**
   * Runs config validation against every registered service's schema. Safe
   * to call multiple times — the config file is read only on the first call,
   * and repeat calls with no new registrations short-circuit as a no-op.
   *
   * The optional `svcs` array is a shorthand: each entry is passed through
   * `registerService()` before validation runs. Existing callers passing all
   * services up front (`validateServices([A, B, C])`) continue to work.
   * Later calls can register additional services (e.g. dynamically-resolved
   * logger/db/mq implementations) and re-validate.
   */
  public async validateServices(svcs?: Array<NexxusServiceClass>): Promise<void> {
    if (svcs) {
      for (const svc of svcs) {
        this.registerService(svc);
      }
    }

    if (!this.hasNewRegistrations) {
      return;
    }

    await this.validate();
    this.hasNewRegistrations = false;
  }

  private populateFromCliArgs(): void {
    if (this.cliArgsSpecs.length === 0) {
      return;
    }

    const collectedNames : Map<string, string> = new Map();
    const cliArgProvider = this.configProviders.at(-1) as NexxusCliArgConfigProvider;

    this.cliArgsSpecs.forEach(spec => {
      spec.specs.forEach((arg) => {
        if (collectedNames.has(arg.name)) {
          throw new InvalidConfigException(`Duplicate CLI argument name: "${arg.name}".
            Defined first by class "${collectedNames.get(arg.name)}" and now by class "${spec.className}"`);
        }

        collectedNames.set(arg.name, spec.className);

        cliArgProvider.addArgument(arg.name, arg.type);
      });
    });

    const parsed = cliArgProvider.getConfig();

    this.cliArgsSpecs.forEach(spec => {
      spec.specs.forEach(arg => {
        if (parsed[arg.name] !== undefined && parsed[arg.name] !== null) {
          Dot.setProperty(this.data, `${spec.configRootKey}.${arg.location}`, parsed[arg.name]);
        }
      });
    });
  }

  private populateFromEnvVars(): void {
    if (this.envVarsSpecs.length === 0) {
      return;
    }

    const collectedNames: Map<string, string> = new Map();
    const envVarProvider = this.configProviders.at(-2) as NexxusEnvVarsConfigProvider;
    const envResult = envVarProvider.getConfig();
    const prefix = NexxusEnvVarsConfigProvider.ENV_VAR_PREFIX;

    this.envVarsSpecs.forEach(spec => {
      spec.specs.forEach(envVar => {
        if (collectedNames.has(envVar.name)) {
          throw new InvalidConfigException(`Duplicate Env var: "${prefix}${envVar.name}".
            Defined first by class "${collectedNames.get(envVar.name)}" and now by class "${spec.className}"`);
        }

        const value = envResult?.[`${prefix}${envVar.name}`];

        if (value !== undefined) {
          Dot.setProperty(this.data, `${spec.configRootKey}.${envVar.location}`, value);
        }

        collectedNames.set(envVar.name, spec.className);
      });
    });
  }

  /**
   * Resolves the custom config providers declared out-of-band via the
   * `NXX_CONFIG_PROVIDERS` env var and appends them to `customProviders` so
   * `populateFromCustomProviders` runs them. No-op when the var is unset.
   *
   * The list can't come from the config file — custom providers are one of
   * the things that PRODUCE the config, so what to load has to arrive from
   * somewhere available before config resolution runs. Malformed JSON or a
   * shape violation is fatal: a mis-declared provider means config can't be
   * trusted, so failing fast beats booting with a half-populated config.
   */
  private async resolveCustomProviders(): Promise<void> {
    const raw = process.env[NexxusConfigManager.CONFIG_PROVIDERS_ENV_VAR];

    if (!raw) {
      return;
    }

    let specs: Array<CustomConfigProviderSpec>;

    try {
      specs = JSON.parse(raw);
    } catch (e) {
      throw new FatalErrorException(
        `${NexxusConfigManager.CONFIG_PROVIDERS_ENV_VAR} is not valid JSON: ${(e as Error).message}`
      );
    }

    if (!Array.isArray(specs)) {
      throw new FatalErrorException(
        `${NexxusConfigManager.CONFIG_PROVIDERS_ENV_VAR} must be a JSON array of config-provider specs.`
      );
    }

    for (const spec of specs) {
      if (!spec || typeof spec.provider !== 'string') {
        throw new FatalErrorException(
          `Each entry in ${NexxusConfigManager.CONFIG_PROVIDERS_ENV_VAR} must be an object with a string "provider" (the provider package name).`
        );
      }

      this.customProviders.push(await this.loadCustomProvider(spec));
      this.fallbackLogger.debug(
        `Loaded custom config provider "${spec.provider}"`,
        NexxusConfigManager.loggerLabel
      );
    }
  }

  /**
   * Dynamically imports the package named by `spec.provider` and instantiates its
   * config-provider class with `spec.options`. Export resolution mirrors
   * `WinstonNexxusLogger.loadCustomTransport`'s priority order:
   *   1. `mod[spec.export]` when `spec.export` is set
   *   2. `mod.default` if it's a class/function (ESM default export)
   *   3. the module itself if it's a class/function (CJS `module.exports = Cls`)
   *
   * Resolution goes through the shared `loadPackage` so it's anchored to the
   * app's install tree, not the library's own location (matters under
   * non-hoisted node_modules layouts like pnpm).
   *
   * Unlike Winston transports — third-party classes with no shared base — a
   * config provider extends one of our own abstract bases, so we can cheaply
   * assert the loaded class really is one before trusting it.
   */
  private async loadCustomProvider(spec: CustomConfigProviderSpec): Promise<INexxusConfigProvider> {
    const mod = await loadPackage(spec.provider);

    let ProviderCtor: any;

    if (spec.export) {
      ProviderCtor = mod[spec.export];

      if (typeof ProviderCtor !== 'function') {
        throw new InvalidConfigException(
          `Config provider package "${spec.provider}" has no export named "${spec.export}" (or it isn't a class).`
        );
      }
    } else if (typeof mod.default === 'function') {
      // ESM `export default class`, or CJS `module.exports = Cls` seen through
      // import()'s synthetic default.
      ProviderCtor = mod.default;
    } else if (typeof mod.default?.default === 'function') {
      // CJS/ESM interop "double default": a TSC/Babel-compiled `export default
      // class` becomes `exports.default = Cls` with `__esModule` set. import()
      // makes the synthetic ESM default the WHOLE module.exports object, so the
      // real class sits one level down at `.default.default`.
      ProviderCtor = mod.default.default;
    } else if (typeof mod === 'function') {
      // Bare CJS `module.exports = Cls` exposed directly on the namespace.
      ProviderCtor = mod;
    } else {
      throw new InvalidConfigException(
        `Could not find a config provider class in package "${spec.provider}". Specify "export" to name the class.`
      );
    }

    const provider = new ProviderCtor(spec.options ?? {});

    if (!(provider instanceof NexxusConfigProvider || provider instanceof NexxusAsyncConfigProvider)) {
      throw new InvalidConfigException(
        `Class resolved from "${spec.provider}" must extend NexxusConfigProvider or NexxusAsyncConfigProvider.`
      );
    }

    return provider;
  }

  private async populateFromCustomProviders(): Promise<void> {
    for (const provider of this.customProviders) {
      const result = await provider.getConfig();

      this.data = deepMerge(this.data, result);
    }
  }

  private formatAjvErrors(errors: ConfigErrorObject) : string {
    return errors.map(err => {
      return `\n${err.instancePath || '#root'}:\n\t${err.message}\n`;
    }).join('\n');
  }

  private async validate() : Promise<void> {
    // File + custom providers only run on the first call. The config file is
    // treated as immutable for this ConfigManager's lifetime — later calls
    // just re-validate the accumulated schema against the cached data (plus
    // any late CLI/env values, which are cheap and idempotent to re-apply).
    if (!this.dataInitialized) {
      const fileConfigProvider = this.configProviders[0] as NexxusFileConfigProvider;

      try {
        this.data = fileConfigProvider.getConfig();
      } catch (e) {
        if (e instanceof FatalErrorException) {
          if (e.subcode === FatalErrorException.SUBCODES.CONFIG_FILE_NOT_FOUND) {
            // If the config file doesn't exist, we treat it as an empty config
            // and let other providers populate the config. If the resulting
            // config is invalid it throws below when the schema is checked.
            this.data = {};
            this.fallbackLogger.warn(
              'Config file not found — proceeding with empty base config; other providers may still populate it',
              NexxusConfigManager.loggerLabel
            );
          } else {
            throw e;
          }
        }
      }

      await this.resolveCustomProviders();
      await this.populateFromCustomProviders();
      this.dataInitialized = true;
    }

    this.populateFromCliArgs();
    this.populateFromEnvVars();

    const ajv = new Ajv({ useDefaults: true });
    const validator = ajv.compile(this.jsonSchema);
    const result : boolean = validator(this.data);

    if (!result) {
      const validationOutput = this.formatAjvErrors(validator.errors as ConfigErrorObject);

      throw new FatalErrorException('Could not validate configuration' + validationOutput);
    }
  }

  public getConfig(field?: string): NexxusConfig {
    if (!field) {
      return this.data;
    }

    return this.data[field];
  }
}
