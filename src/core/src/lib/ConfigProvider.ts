import { FatalErrorException, FatalErrorSubcodes, InvalidConfigException } from './Exceptions';

import * as fs from "fs";

import { ArgumentParser, SUPPRESS } from 'argparse';

export type NexxusConfig = Record<string, any>;
export type CliArgType = 'int' | 'string' | 'boolean' | 'float' | 'json';

export interface INexxusConfigProvider {
  getConfig(): NexxusConfig | Promise<NexxusConfig>
}

export abstract class NexxusConfigProvider implements INexxusConfigProvider {
  public abstract readonly name: string;

  abstract getConfig(): NexxusConfig

  /**
   * Coerce a raw CLI/env string to its declared type, throwing
   * `InvalidConfigException` (labelled with the offending var) on a value that
   * can't be represented. Lives on the provider — not in ConfigManager — so
   * string→value typing is a provider concern; the env and CLI providers both
   * use it.
   */
  public coerce(raw: string, type: CliArgType, label: string): unknown {
    switch (type) {
      case 'string':
        return raw;

      case 'int': {
        const n = Number(raw);

        if (!Number.isInteger(n)) {
          throw new InvalidConfigException(`${label}: expected an integer, got "${raw}"`);
        }

        return n;
      }

      case 'float': {
        const n = Number(raw);

        if (Number.isNaN(n)) {
          throw new InvalidConfigException(`${label}: expected a number, got "${raw}"`);
        }

        return n;
      }

      case 'boolean': {
        const v = raw.trim().toLowerCase();

        if (v === 'true' || v === '1') {
          return true;
        }

        if (v === 'false' || v === '0') {
          return false;
        }

        throw new InvalidConfigException(`${label}: expected a boolean ('true'/'false'/'1'/'0'), got "${raw}"`);
      }

      case 'json':
        // Parse only — the resulting structure is validated by the schema, so
        // we just guarantee the string is valid JSON here.
        try {
          return JSON.parse(raw);
        } catch (e) {
          throw new InvalidConfigException(`${label}: expected valid JSON — ${(e as Error).message}`);
        }

      default:
        throw new InvalidConfigException(`${label}: unknown config value type "${String(type)}"`);
    }
  }
}

export abstract class NexxusAsyncConfigProvider implements INexxusConfigProvider {
  public abstract readonly name: string;

  abstract getConfig(): Promise<NexxusConfig>
}

export class NexxusFileConfigProvider extends NexxusConfigProvider {
  public readonly name: string = 'NexxusFileConfigProvider';

  constructor(private filePath: string) {
    super();
  }

  public getConfig(): NexxusConfig {
    try {
      fs.accessSync(this.filePath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new FatalErrorException(`Cannot access config file "${this.filePath}": ${e.message}`, FatalErrorSubcodes.CONFIG_FILE_NOT_FOUND);
      } else if (e.code === 'EACCES') {
        throw new FatalErrorException(`Cannot access config file "${this.filePath}": ${e.message}`, FatalErrorSubcodes.CONFIG_FILE_UNREADABLE);
      } else {
        throw new FatalErrorException(`Failed reading config file "${this.filePath}": ${e.message}`);
      }
    }

    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as NexxusConfig;
  }
}

export class NexxusEnvVarsConfigProvider extends NexxusConfigProvider {
  public readonly name: string = 'NexxusEnvVarsConfigProvider';

  public static readonly ENV_VAR_PREFIX : Readonly<string> = 'NXX_';

  public getConfig(): NexxusConfig {
    const result : NexxusConfig = {};

    Object.keys(process.env).forEach(key => {
      if (key.startsWith(NexxusEnvVarsConfigProvider.ENV_VAR_PREFIX)) {
        result[key] = process.env[key] as string;
      }
    });

    return result;
  }
}

export class NexxusCliArgConfigProvider extends NexxusConfigProvider {
  public readonly name: string = 'NexxusCliArgConfigProvider';

  private argParser: ArgumentParser;
  private originalExit: (status: number, message: string) => void;
  private addedArgs: Set<string> = new Set();

  constructor() {
    super();

    this.argParser = new ArgumentParser({ add_help: false, usage: SUPPRESS });
    this.originalExit = this.argParser.exit.bind(this.argParser);
    this.argParser.exit = (status: number, message: string) => {
      if (message.search('unrecognized arguments: ') === -1) {
        this.originalExit(status, message);
      }
    }
  }

  /**
   * Idempotent per argument name — safe to call multiple times across repeat
   * `ConfigManager.validateServices()` invocations. Argparse would otherwise
   * throw on a second `add_argument` with the same name.
   */
  public addArgument(name: string): void {
    if (this.addedArgs.has(name)) {
      return;
    }

    // Collect as a raw string; ConfigManager coerces the value via the
    // provider's `coerce()` so CLI and env share one typing + validation path.
    this.argParser.add_argument(`--${name}`, { dest: name, required: false });
    this.addedArgs.add(name);
  }

  public getConfig(): NexxusConfig {
    return this.argParser.parse_args();
  }
}
