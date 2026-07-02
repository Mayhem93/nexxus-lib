import { FatalErrorException } from "./Exceptions";

import * as fs from "fs";

import { ArgumentParser, SUPPRESS } from "argparse";

export type NexxusConfig = Record<string, any>;
export type CliArgType = "int" | "str" | "boolean" | "float";

export interface INexxusConfigProvider {
  getConfig(): NexxusConfig | Promise<NexxusConfig>
}

export abstract class NexxusConfigProvider implements INexxusConfigProvider {
  abstract getConfig(): NexxusConfig
}

export abstract class NexxusAsyncConfigProvider implements INexxusConfigProvider {
  abstract getConfig(): Promise<NexxusConfig>
}

export class NexxusFileConfigProvider extends NexxusConfigProvider {
  constructor(private filePath: string) {
    super();
  }

  public getConfig(): NexxusConfig {
    try {
      fs.accessSync(this.filePath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new FatalErrorException(`Cannot access config file "${this.filePath}": ${e.message}`, FatalErrorException.SUBCODES.CONFIG_FILE_NOT_FOUND);
      } else if (e.code === 'EACCES') {
        throw new FatalErrorException(`Cannot access config file "${this.filePath}": ${e.message}`, FatalErrorException.SUBCODES.CONFIG_FILE_UNREADABLE);
      } else {
        throw new FatalErrorException(`Failed reading config file "${this.filePath}": ${e.message}`);
      }
    }

    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as NexxusConfig;
  }
}

export class NexxusEnvVarsConfigProvider extends NexxusConfigProvider {
  static ENV_VAR_PREFIX : Readonly<string> = "NXX_";

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
  private argParser: ArgumentParser;
  private originalExit: (status: number, message: string) => void;
  private addedArgs: Set<string> = new Set();

  constructor() {
    super();

    this.argParser = new ArgumentParser({ add_help: false, usage: SUPPRESS });
    this.originalExit = this.argParser.exit.bind(this.argParser);
    this.argParser.exit = (status: number, message: string) => {
      if (message.search("unrecognized arguments: ") === -1) {
        this.originalExit(status, message);
      }
    }
  }

  /**
   * Idempotent per argument name — safe to call multiple times across repeat
   * `ConfigManager.validateServices()` invocations. Argparse would otherwise
   * throw on a second `add_argument` with the same name.
   */
  public addArgument(name: string, type: CliArgType): void {
    if (this.addedArgs.has(name)) {
      return;
    }

    this.argParser.add_argument(`--${name}`, { type: type, dest: name, required: false });
    this.addedArgs.add(name);
  }

  public getConfig(): NexxusConfig {
    return this.argParser.parse_args();
  }
}
