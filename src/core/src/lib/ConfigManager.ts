import { FatalErrorException, InvalidConfigException } from "./Exceptions";
import { NexxusBaseService } from './BaseService';
import {
  CliArgType,
  NexxusConfig,
  INexxusConfigProvider,
  NexxusFileConfigProvider,
  NexxusEnvVarsConfigProvider,
  NexxusCliArgConfigProvider
} from "./ConfigProvider";

import { Ajv, ErrorObject } from "ajv";
import * as Dot from "dot-prop";
import deepMerge from "deepmerge";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

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

export class NexxusConfigManager {
  private static CONF_FILE_NAME : Readonly<string> = "nexxus.conf.json";

  private jsonSchema: JSONSchema7;
  private envVarsSpecs: Array<RegisteredSpecs<ConfigEnvVars>> = [];
  private cliArgsSpecs: Array<RegisteredSpecs<ConfigCliArgs>> = [];
  private data: NexxusConfig = {};

  private configProviders : Array<INexxusConfigProvider> = [];
  private customProviders : Array<INexxusConfigProvider> = [];

  constructor(configFileName? : string) {
    const schemaPath = path.join(__dirname, "../../src/schemas/root.schema.json");

    this.jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    this.configProviders.push(new NexxusFileConfigProvider(path.join(process.cwd(), configFileName ?? NexxusConfigManager.CONF_FILE_NAME)));
    this.configProviders.push(new NexxusEnvVarsConfigProvider());
    this.configProviders.push(new NexxusCliArgConfigProvider());
  }

  public addCustomProvider(provider: INexxusConfigProvider): void {
    this.configProviders.splice(1, 0, provider);
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

  public async validateServices(svcs : Array<typeof NexxusBaseService>) : Promise<void> {
    for(const NxxSvc of svcs) {
      const schemaDef = NxxSvc.schema();
      const className = NxxSvc.name;
      const configRootKey = schemaDef.where;

      this.cliArgsSpecs.push({ className, configRootKey, specs: NxxSvc.cliArgConfig() });
      this.envVarsSpecs.push({ className, configRootKey, specs: NxxSvc.envVarConfig() });
      this.addJsonSchemaDef(schemaDef);
    }

    await this.validate();
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
    const fileConfigProvider = this.configProviders[0] as NexxusFileConfigProvider;

    this.data = fileConfigProvider.getConfig();

    await this.populateFromCustomProviders();
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
