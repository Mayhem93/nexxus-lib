import { ConfigEnvVars, ConfigCliArgs } from './ConfigManager';
import { NexxusBaseService, INexxusBaseServices } from './BaseService';
import { NexxusConfig } from './ConfigProvider';
import { InvalidConfigException } from './Exceptions';

import * as Winston from 'winston';

import * as path from 'node:path';

export type LogAttributes = Record<string, unknown>;

export const enum NexxusLoggerLevels {
  EMERGENCY = "emerg",
  ALERT = "alert",
  CRITICAL = "crit",
  ERROR = "error",
  WARNING = "warn",
  NOTICE = "notice",
  INFO = "info",
  DEBUG = "debug"
}

export type StdoutTransportConfig = { type: 'stdout' };
export type FileTransportConfig = {
  type: 'file';
  filename: string;
  maxSize?: number;
  maxFiles?: number;
};
/**
 * Catch-all for transports loaded dynamically from npm packages. The `type`
 * field is the package name (e.g. "winston-papertrail"); `export` optionally
 * names the class export within the package; `options` is the passthrough
 * config object handed to the transport's constructor.
 *
 * The schema's `oneOf` discriminator excludes built-in type strings from this
 * variant, so the TS-side `type: string` doesn't cause ambiguity at runtime.
 */
export type CustomTransportConfig = {
  type: string;
  export?: string;
  options?: Record<string, unknown>;
};
export type WinstonNexxusTransportConfig =
  | StdoutTransportConfig
  | FileTransportConfig
  | CustomTransportConfig;

type WinstonNexxusLoggerConfig = {
  level: NexxusLoggerLevels;
  logType: "json" | "text";
  timestamps: boolean;
  colors: boolean;
  transports?: Array<WinstonNexxusTransportConfig>;
} & NexxusConfig;

export interface INexxusLogger {
  log(level: NexxusLoggerLevels, message: string, attributes?: LogAttributes, label?: string): void
}

export interface INexxusAsyncLogger {
  log(level: NexxusLoggerLevels, message: string, attributes?: LogAttributes, label?: string): Promise<void>
}

interface NexxusLoggerServices extends Omit<INexxusBaseServices, 'logger'> {}

export abstract class NexxusBaseLogger<T extends NexxusConfig> extends NexxusBaseService<T> implements INexxusLogger {

  protected static configRootKey: string = "logger";

  constructor(services: NexxusLoggerServices) {
    super(services.configManager.getConfig('logger') as T);
  }

  public abstract log(level: NexxusLoggerLevels, message: string, attributes?: LogAttributes, label?: string): void;

  protected static serializeError(err: Error): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };

    if (err.cause !== undefined) {
      out.cause = err.cause;
    }

    return out;
  }

  protected static makeSafeReplacer(): (key: string, value: unknown) => unknown {
    const seen = new WeakSet<object>();

    return (_key, value) => {
      if (value instanceof Error) {
        return NexxusBaseLogger.serializeError(value);
      }

      if (value !== null && typeof value === 'object') {
        if (seen.has(value as object)) {
          return '[circular]';
        }

        seen.add(value as object);
      }

      return value;
    };
  }

  protected static safeStringify(value: unknown): string {
    return JSON.stringify(value, NexxusBaseLogger.makeSafeReplacer());
  }

  public debug(message: string, label?: string): void;
  public debug(message: string, attributes: LogAttributes, label?: string): void;
  public debug(message: string, attributesOrLabel?: LogAttributes | string, label?: string): void {
    this.dispatch(NexxusLoggerLevels.DEBUG, message, attributesOrLabel, label);
  }

  public info(message: string, label?: string): void;
  public info(message: string, attributes: LogAttributes, label?: string): void;
  public info(message: string, attributesOrLabel?: LogAttributes | string, label?: string): void {
    this.dispatch(NexxusLoggerLevels.INFO, message, attributesOrLabel, label);
  }

  public warn(message: string, label?: string): void;
  public warn(message: string, attributes: LogAttributes, label?: string): void;
  public warn(message: string, attributesOrLabel?: LogAttributes | string, label?: string): void {
    this.dispatch(NexxusLoggerLevels.WARNING, message, attributesOrLabel, label);
  }

  public error(message: string, label?: string): void;
  public error(message: string, attributes: LogAttributes, label?: string): void;
  public error(message: string, attributesOrLabel?: LogAttributes | string, label?: string): void {
    this.dispatch(NexxusLoggerLevels.ERROR, message, attributesOrLabel, label);
  }

  public critical(message: string, label?: string): void;
  public critical(message: string, attributes: LogAttributes, label?: string): void;
  public critical(message: string, attributesOrLabel?: LogAttributes | string, label?: string): void {
    this.dispatch(NexxusLoggerLevels.CRITICAL, message, attributesOrLabel, label);
  }

  public alert(message: string, label?: string): void;
  public alert(message: string, attributes: LogAttributes, label?: string): void;
  public alert(message: string, attributesOrLabel?: LogAttributes | string, label?: string): void {
    this.dispatch(NexxusLoggerLevels.ALERT, message, attributesOrLabel, label);
  }

  public emerg(message: string, label?: string): void;
  public emerg(message: string, attributes: LogAttributes, label?: string): void;
  public emerg(message: string, attributesOrLabel?: LogAttributes | string, label?: string): void {
    this.dispatch(NexxusLoggerLevels.EMERGENCY, message, attributesOrLabel, label);
  }

  private dispatch(level: NexxusLoggerLevels, message: string, attributesOrLabel: LogAttributes | string | undefined, label: string | undefined): void {
    if (typeof attributesOrLabel === 'string') {
      this.log(level, message, undefined, attributesOrLabel);
    } else {
      this.log(level, message, attributesOrLabel, label);
    }
  }
}

export class WinstonNexxusLogger extends NexxusBaseLogger<WinstonNexxusLoggerConfig> {
  private winston : Winston.Logger;
  protected static schemaPath: string = path.join(__dirname, "../../src/schemas/winston-logger.schema.json");
  protected static envVars: ConfigEnvVars = [
    { name: "LOG_LEVEL", location: "level" }
  ];
  protected static cliArgs: ConfigCliArgs = [];

  /**
   * Private — use `WinstonNexxusLogger.create(...)` instead. Transport instances
   * must be resolved (async, since custom ones are dynamically imported) before
   * the Winston logger can be constructed; the factory owns that step.
   */
  private constructor(services: NexxusLoggerServices, resolvedTransports: Array<Winston.transport>) {
    super(services);

    let format: Winston.Logform.Format;

    if (this.config.logType === "json") {
      format = Winston.format.printf(info => {
        const record: Record<string, unknown> = {};

        if (info.timestamp) {
          record.time = info.timestamp;
        }

        record.level = info.level;
        record.label = (info.label as string | undefined) ?? "default-label";
        record.msg = info.message;

        const attrs = info.attrs as LogAttributes | undefined;

        if (attrs && typeof attrs === 'object' && Object.keys(attrs).length > 0) {
          record.attrs = attrs;
        }

        return WinstonNexxusLogger.safeStringify(record);
      });

      if (this.config.timestamps) {
        format = Winston.format.combine(
          Winston.format.timestamp(),
          format
        );
      }
    } else {
      format = Winston.format.printf(info => {
        const label = (info.label as string | undefined) ?? "default-label";
        const timestampPrefix = info.timestamp ? `[${info.timestamp}] ` : '';
        const header = `${timestampPrefix}${info.level.toLocaleUpperCase()} [${label}]: ${info.message}`;

        const attrs = info.attrs as LogAttributes | undefined;

        if (!attrs || typeof attrs !== 'object' || Object.keys(attrs).length === 0) {
          return header;
        }

        const lines = [header];

        for (const [k, v] of Object.entries(attrs)) {
          lines.push(`  ${k}: ${WinstonNexxusLogger.safeStringify(v)}`);
        }

        return lines.join('\n');
      });

      if (this.config.timestamps) {
        format = Winston.format.combine(
          Winston.format.timestamp(),
          format
        );
      }

      if (this.config.colors) {
        format = Winston.format.combine(
          Winston.format.colorize(),
          format
        );
      }
    }

    this.winston = Winston.createLogger({
      level: this.config.level,
      format,
      transports: resolvedTransports
    });
  }

  /**
   * Async factory. Custom transports are loaded via dynamic `import()` so
   * initialization is unavoidably async. API/Worker bootstrap code should
   * `await WinstonNexxusLogger.create(...)` in place of `new WinstonNexxusLogger(...)`.
   */
  public static async create(services: NexxusLoggerServices): Promise<WinstonNexxusLogger> {
    const config = services.configManager.getConfig('logger') as WinstonNexxusLoggerConfig;
    const resolvedTransports = await WinstonNexxusLogger.resolveTransports(config);

    return new WinstonNexxusLogger(services, resolvedTransports);
  }

  /**
   * Maps each transport config entry to a constructed Winston transport.
   * Built-in types are instantiated synchronously; everything else falls
   * through to `loadCustomTransport`, which dynamically imports the npm
   * package named by `type`.
   *
   * If the config has no transports (undefined or empty array), defaults to
   * a single Console transport so the logger is never silent.
   */
  private static async resolveTransports(config: WinstonNexxusLoggerConfig): Promise<Array<Winston.transport>> {
    const entries: Array<WinstonNexxusTransportConfig> = config.transports?.length
      ? config.transports
      : [{ type: 'stdout' }];
    const resolved: Array<Winston.transport> = [];

    for (const entry of entries) {
      switch (entry.type) {
        case 'stdout':
          resolved.push(new Winston.transports.Console());

          break;

        case 'file': {
          const fileEntry = entry as FileTransportConfig;

          resolved.push(new Winston.transports.File({
            filename: fileEntry.filename,
            maxsize:  fileEntry.maxSize,
            maxFiles: fileEntry.maxFiles,
            zippedArchive: true
          }));

          break;
        }

        default:
          resolved.push(await WinstonNexxusLogger.loadCustomTransport(entry as CustomTransportConfig));
      }
    }

    return resolved;
  }

  /**
   * Dynamically imports the npm package named by `transport.type` and instantiates
   * its transport class. The class is resolved in priority order:
   *   1. `mod[transport.export]` if `transport.export` is set in config
   *   2. `mod.default` if it's a function/class (ESM default export)
   *   3. The module itself if it's a function/class (CJS `module.exports = Cls`)
   *
   * On any failure (package missing, no resolvable class, constructor throws)
   * we re-wrap as `InvalidConfigException` so the operator sees an actionable
   * message rather than a raw module-resolution stack trace.
   */
  private static async loadCustomTransport(transport: CustomTransportConfig): Promise<Winston.transport> {
    let mod: any;

    try {
      mod = await import(transport.type);
    } catch (e) {
      throw new InvalidConfigException(
        `Transport package "${transport.type}" could not be loaded — make sure it's installed in your deployment. Underlying error: ${(e as Error).message}`
      );
    }

    let TransportCtor: any;

    if (transport.export) {
      TransportCtor = mod[transport.export];

      if (typeof TransportCtor !== 'function') {
        throw new InvalidConfigException(
          `Transport package "${transport.type}" has no export named "${transport.export}" (or it isn't a class/function)`
        );
      }
    } else if (typeof mod.default === 'function') {
      TransportCtor = mod.default;
    } else if (typeof mod === 'function') {
      TransportCtor = mod;
    } else {
      throw new InvalidConfigException(
        `Could not find a transport class in package "${transport.type}". Specify "export" in the transport config to name the class.`
      );
    }

    return new TransportCtor(transport.options ?? {}) as Winston.transport;
  }

  public log(level: NexxusLoggerLevels, message: string, attributes?: LogAttributes, label?: string): void {
    this.winston.log(level, message, { label, attrs: attributes });
  }
}
