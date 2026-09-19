import { NexxusElasticsearchDb } from '@mayhem93/nexxus-database-lib';
import { NexxusBaseLogger, type INexxusBaseServices } from '@mayhem93/nexxus-core-lib';

export class TestLogger extends NexxusBaseLogger<Record<string, unknown>> {
  public entries: Array<{ level: string; message: string }> = [];
  public log(level: string, message: string): void { this.entries.push({ level, message }); }
  public async getStats(): Promise<Record<string, unknown>> { return {}; }
  public has(level: string, re: RegExp): boolean { return this.entries.some(e => e.level === level && re.test(e.message)); }
}

export const logger = new TestLogger({});

const DEFAULT_CONFIG = { host: 'es.local', port: 9200, user: 'u', password: 'p' };

/** Construct a NexxusElasticsearchDb wired to the fake client + capturing logger. */
export function makeDb(config: Record<string, unknown> = DEFAULT_CONFIG): NexxusElasticsearchDb {
  logger.entries = [];
  const services = { configManager: { getConfig: () => config }, logger } as unknown as INexxusBaseServices;

  return new NexxusElasticsearchDb(services);
}
