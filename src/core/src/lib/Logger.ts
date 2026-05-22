import { ConfigEnvVars, ConfigCliArgs } from './ConfigManager';
import { NexxusBaseService, INexxusBaseServices } from './BaseService';
import { NexxusConfig } from './ConfigProvider';

import * as Winston from 'winston';

import * as path from "node:path";

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

type WinstonNexxusLoggerConfig = {
  level: NexxusLoggerLevels;
  logType: "json" | "text";
  timestamps: boolean;
  colors: boolean;
} & NexxusConfig;

export interface INexxusLogger {
  log(level: NexxusLoggerLevels, message: string, attributes?: LogAttributes, label?: string): void
}

export interface INexxusAsyncLogger {
  log(level: NexxusLoggerLevels, message: string, attributes?: LogAttributes, label?: string): Promise<void>
}

interface NexxusLoggerServices extends Omit<INexxusBaseServices, 'logger'> {}

export abstract class NexxusBaseLogger<T extends NexxusConfig> extends NexxusBaseService<T> implements INexxusLogger {

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
  protected static envVars: ConfigEnvVars = {
    source: this.name,
    specs: [
      {
        name: "LOG_LEVEL",
        location: "logger.level"
      }
    ]
  };
  protected static cliArgs: ConfigCliArgs = {
    source: this.name,
    specs: []
  }

  constructor(services: NexxusLoggerServices) {
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
      transports: [
        new Winston.transports.Console()
      ]
    });
  }

  public log(level: NexxusLoggerLevels, message: string, attributes?: LogAttributes, label?: string): void {
    this.winston.log(level, message, { label, attrs: attributes });
  }
}
