import { describe, it, expect, afterAll } from 'vitest';
import { NexxusBaseService } from '@mayhem93/nexxus-core-lib';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A real schema file on disk — BaseService.schema() reads it via fs.readFileSync.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxx-svc-'));
const schemaFile = path.join(dir, 'schema.json');
const SCHEMA_DEF = { type: 'object', properties: { host: { type: 'string' } } };

fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA_DEF));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const ENV_VARS = { NXX_HOST: { path: 'host', type: 'string' } } as never;
const CLI_ARGS = { host: { path: 'host', type: 'string' } } as never;

/** Fully-configured concrete service — all required statics set. */
class FullService extends NexxusBaseService<Record<string, unknown>, { ping: [number] }> {
  protected static envVars = ENV_VARS;
  protected static cliArgs = CLI_ARGS;
  protected static configRootKey = 'full';
  protected static schemaPath = schemaFile;

  public async getStats(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public exposeConfig(): Record<string, unknown> {
    return this.config;
  }
}

/** Concrete service with NONE of the static config set — for the "not set" throws. */
class BareService extends NexxusBaseService<Record<string, unknown>> {
  public async getStats(): Promise<Record<string, unknown>> {
    return {};
  }
}

/** Has schemaPath but NOT configRootKey — to hit that specific schema() guard. */
class SchemaOnlyService extends NexxusBaseService<Record<string, unknown>> {
  protected static schemaPath = schemaFile;

  public async getStats(): Promise<Record<string, unknown>> {
    return {};
  }
}

describe('NexxusBaseService static config accessors', () => {
  it('envVarConfig returns the spec when set, throws when not', () => {
    expect(FullService.envVarConfig()).toBe(ENV_VARS);
    expect(() => BareService.envVarConfig()).toThrow(/Env vars spec not set for BareService/);
  });

  it('cliArgConfig returns the spec when set, throws when not', () => {
    expect(FullService.cliArgConfig()).toBe(CLI_ARGS);
    expect(() => BareService.cliArgConfig()).toThrow(/CLI args spec not set for BareService/);
  });

  it('schema throws when schemaPath is not set', () => {
    expect(() => BareService.schema()).toThrow(/Schema path not set for BareService/);
  });

  it('schema throws when configRootKey is not set', () => {
    expect(() => SchemaOnlyService.schema()).toThrow(/configRootKey not set for SchemaOnlyService/);
  });

  it('schema reads the file and returns the definition descriptor', () => {
    const descriptor = FullService.schema();

    expect(descriptor).toEqual({
      name: 'FullService',
      where: 'full',
      definition: SCHEMA_DEF,
      required: true,
    });
  });

  it('schema caches file contents (survives deletion of the source file)', () => {
    FullService.schema();       // populate cache (already warm from previous test)
    fs.rmSync(schemaFile);      // remove the underlying file

    // A cache miss would now throw ENOENT — it doesn't, proving the cache.
    expect(FullService.schema().definition).toEqual(SCHEMA_DEF);
  });
});

describe('NexxusBaseService instance', () => {
  it('stores the config passed to the constructor', () => {
    const cfg = { host: 'localhost' };
    const service = new FullService(cfg);

    expect(service.exposeConfig()).toEqual({ host: 'localhost' });
  });

  it('implements the abstract getStats contract', async () => {
    expect(await new FullService({}).getStats()).toEqual({ ok: true });
  });
});

describe('NexxusBaseService typed event emitter', () => {
  it('on + emit delivers the payload', () => {
    const service = new FullService({});
    let received: number | undefined;

    service.on('ping', (n) => { received = n; });
    service.emit('ping', 42);

    expect(received).toBe(42);
  });

  it('once fires a listener only for the first emit', () => {
    const service = new FullService({});
    let count = 0;

    service.once('ping', () => { count++; });
    service.emit('ping', 1);
    service.emit('ping', 2);

    expect(count).toBe(1);
  });

  it('off removes a previously-registered listener', () => {
    const service = new FullService({});
    let count = 0;
    const listener = () => { count++; };

    service.on('ping', listener);
    service.off('ping', listener);
    service.emit('ping', 1);

    expect(count).toBe(0);
  });
});
