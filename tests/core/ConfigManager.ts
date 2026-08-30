import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { NexxusConfigManager, NexxusBaseService } from '@mayhem93/nexxus-core-lib';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxx-cfgmgr-'));

// A service config schema: an object requiring a string `host`.
const dbSchemaFile = path.join(dir, 'db.schema.json');

fs.writeFileSync(dbSchemaFile, JSON.stringify({
  type: 'object',
  properties: { host: { type: 'string' } },
  required: ['host'],
  additionalProperties: true,
}));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/* Test service classes. Statics drive registerService (schema/env/cli specs). */
class DbService extends NexxusBaseService<Record<string, unknown>> {
  protected static schemaPath = dbSchemaFile;
  protected static configRootKey = 'database';
  protected static envVars = [{ name: 'DB_HOST', location: 'host', type: 'string' as const }];
  protected static cliArgs = [{ name: 'db-host', location: 'host', type: 'string' as const }];

  public async getStats(): Promise<Record<string, unknown>> {
    return {};
  }
}

class DupCliService extends NexxusBaseService<Record<string, unknown>> {
  protected static schemaPath = dbSchemaFile;
  protected static configRootKey = 'dupcli';
  protected static envVars = [];
  protected static cliArgs = [{ name: 'db-host', location: 'host', type: 'string' as const }]; // collides with DbService

  public async getStats(): Promise<Record<string, unknown>> {
    return {};
  }
}

class DupEnvService extends NexxusBaseService<Record<string, unknown>> {
  protected static schemaPath = dbSchemaFile;
  protected static configRootKey = 'dupenv';
  protected static envVars = [{ name: 'DB_HOST', location: 'host', type: 'string' as const }]; // collides with DbService
  protected static cliArgs = [];

  public async getStats(): Promise<Record<string, unknown>> {
    return {};
  }
}

/** Write a config JSON file and return its path. */
let fileCounter = 0;
const writeConfig = (data: unknown): string => {
  const file = path.join(dir, `conf-${fileCounter++}.json`);

  fs.writeFileSync(file, JSON.stringify(data));

  return file;
};

// Snapshot + restore env and argv around each test.
let savedEnv: NodeJS.ProcessEnv;
let savedArgv: string[];

beforeEach(() => {
  savedEnv = { ...process.env };
  savedArgv = process.argv;
  // Ensure no ambient config-provider list leaks in.
  delete process.env.NXX_CONFIG_PROVIDERS;
  delete process.env.NXX_CONF_PATH;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  process.argv = savedArgv;
});

describe('NexxusConfigManager construction + getConfig', () => {
  it('exposes a fallback logger and an empty config before validation', () => {
    const cm = new NexxusConfigManager(writeConfig({}));

    expect(cm.fallbackLogger).toBeDefined();
    expect(cm.getConfig()).toEqual({});
    expect(cm.getConfig('anything')).toBeUndefined();
  });

  it('resolves the config path from NXX_CONF_PATH when no argument is given', () => {
    process.env.NXX_CONF_PATH = writeConfig({ database: { host: 'from-env-path' } });

    // Construction just resolves the path + reads the root schema; no throw.
    expect(new NexxusConfigManager().getConfig()).toEqual({});
  });

  it('falls back to the default config path when neither an argument nor NXX_CONF_PATH is set', () => {
    delete process.env.NXX_CONF_PATH;

    // The default path (/etc/nexxus/…) almost certainly does not exist, but the
    // constructor only resolves it — it isn't read until validate().
    expect(new NexxusConfigManager().getConfig()).toEqual({});
  });
});

describe('NexxusConfigManager validateServices — happy paths', () => {
  it('reads the config file and validates a registered service', async () => {
    const cm = new NexxusConfigManager(writeConfig({ database: { host: 'file-host' } }));

    cm.registerService(DbService);
    await cm.validateServices();

    expect(cm.getConfig('database')).toEqual({ host: 'file-host' });
  });

  it('accepts services passed directly to validateServices()', async () => {
    const cm = new NexxusConfigManager(writeConfig({ database: { host: 'h' } }));

    await cm.validateServices([DbService]);

    expect(cm.getConfig('database')).toEqual({ host: 'h' });
  });

  it('is a no-op when called again with no new registrations', async () => {
    const cm = new NexxusConfigManager(writeConfig({ database: { host: 'h' } }));

    await cm.validateServices([DbService]);
    await expect(cm.validateServices()).resolves.toBeUndefined(); // second call short-circuits
  });

  it('registering the same class twice is idempotent (no duplicate-spec error)', async () => {
    process.env.NXX_DB_HOST = 'env-host';
    const cm = new NexxusConfigManager(writeConfig({}));

    cm.registerService(DbService);
    cm.registerService(DbService); // must not double-add specs

    await cm.validateServices();

    expect(cm.getConfig('database')).toEqual({ host: 'env-host' });
  });

  it('populates config from an environment variable', async () => {
    process.env.NXX_DB_HOST = 'env-host';
    const cm = new NexxusConfigManager(writeConfig({}));

    await cm.validateServices([DbService]);

    expect(cm.getConfig('database')).toEqual({ host: 'env-host' });
  });

  it('populates config from a CLI argument', async () => {
    process.argv = ['node', 'script', '--db-host', 'cli-host'];
    const cm = new NexxusConfigManager(writeConfig({}));

    await cm.validateServices([DbService]);

    expect(cm.getConfig('database')).toEqual({ host: 'cli-host' });
  });
});

describe('NexxusConfigManager validateServices — failures', () => {
  it('throws a FatalError with the offending path when validation fails', async () => {
    const cm = new NexxusConfigManager(writeConfig({})); // no database key, service requires it

    await expect(cm.validateServices([DbService])).rejects.toThrow(/Could not validate configuration/);
  });

  it('proceeds with an empty base config (and warns) when the file is missing', async () => {
    process.env.NXX_DB_HOST = 'env-host';
    const cm = new NexxusConfigManager(path.join(dir, 'does-not-exist.json'));
    const warn = vi.spyOn(cm.fallbackLogger, 'warn').mockImplementation(() => {});

    await cm.validateServices([DbService]);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Config file not found/), expect.any(String));
    expect(cm.getConfig('database')).toEqual({ host: 'env-host' });
  });

  it('rethrows a non-NOT_FOUND file read error (e.g. the path is a directory)', async () => {
    const cm = new NexxusConfigManager(dir); // a directory → EISDIR, not ENOENT

    await expect(cm.validateServices([DbService])).rejects.toThrow(/Failed reading config file/);
  });

  it('throws on a duplicate CLI argument name across services', async () => {
    const cm = new NexxusConfigManager(writeConfig({}));

    await expect(cm.validateServices([DbService, DupCliService])).rejects.toThrow(/Duplicate CLI argument name: "db-host"/);
  });

  it('throws on a duplicate env var name across services', async () => {
    const cm = new NexxusConfigManager(writeConfig({}));

    await expect(cm.validateServices([DbService, DupEnvService])).rejects.toThrow(/Duplicate Env var: "NXX_DB_HOST"/);
  });
});

describe('NexxusConfigManager custom config providers (NXX_CONFIG_PROVIDERS)', () => {
  const validConfig = () => new NexxusConfigManager(writeConfig({ database: { host: 'h' } }));

  it('rejects invalid JSON', async () => {
    process.env.NXX_CONFIG_PROVIDERS = '{not json';
    const cm = validConfig();

    await expect(cm.validateServices([DbService])).rejects.toThrow(/NXX_CONFIG_PROVIDERS is not valid JSON/);
  });

  it('rejects a non-array value', async () => {
    process.env.NXX_CONFIG_PROVIDERS = '{"provider":"x"}';
    const cm = validConfig();

    await expect(cm.validateServices([DbService])).rejects.toThrow(/must be a JSON array/);
  });

  it('rejects a spec without a string "provider"', async () => {
    process.env.NXX_CONFIG_PROVIDERS = '[{"notProvider":true}]';
    const cm = validConfig();

    await expect(cm.validateServices([DbService])).rejects.toThrow(/must be an object with a string "provider"/);
  });

  it('rejects a provider package that cannot be resolved', async () => {
    process.env.NXX_CONFIG_PROVIDERS = '[{"provider":"this-provider-pkg-does-not-exist-xyz"}]';
    const cm = validConfig();

    await expect(cm.validateServices([DbService])).rejects.toThrow(/could not be resolved/);
  });
});
