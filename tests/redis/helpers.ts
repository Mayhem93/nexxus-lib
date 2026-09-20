import { NexxusRedis } from '@mayhem93/nexxus-redis';
import { NexxusBaseLogger } from '@mayhem93/nexxus-core-lib';
import { FakeRedis } from './fakeRedis';

/** Capturing logger the models log through (NexxusRedis.logger is static). */
export class TestLogger extends NexxusBaseLogger<Record<string, unknown>> {
  public entries: Array<{ level: string; message: string }> = [];
  public log(level: string, message: string): void { this.entries.push({ level, message }); }
  public async getStats(): Promise<Record<string, unknown>> { return {}; }
  public has(level: string, re: RegExp): boolean { return this.entries.some(e => e.level === level && re.test(e.message)); }
}

export const logger = new TestLogger({});

/** Point NexxusRedis's static instance/logger at a fresh in-memory fake for model tests. */
export function installFakeRedis(): FakeRedis {
  const fake = new FakeRedis();

  logger.entries = [];
  (NexxusRedis as unknown as { instance: unknown }).instance = { getClient: () => fake };
  (NexxusRedis as unknown as { logger: unknown }).logger = logger;

  return fake;
}
