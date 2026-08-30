import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import {
  NexxusConfigProvider,
  NexxusFileConfigProvider,
  NexxusEnvVarsConfigProvider,
  NexxusCliArgConfigProvider,
  type NexxusConfig,
  type CliArgType
} from '@mayhem93/nexxus-core-lib';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Running as root on POSIX bypasses chmod(0o000), so the unreadable-file test can't work there. */
const isPosixRoot = process.platform !== 'win32'
  && typeof process.getuid === 'function'
  && process.getuid() === 0;

/** Minimal concrete provider so we can exercise the abstract base's `coerce`. */
class TestCoercer extends NexxusConfigProvider {
  public readonly name = 'TestCoercer';
  public getConfig(): NexxusConfig { return {}; }
}

describe('NexxusConfigProvider.coerce', () => {
  const c = new TestCoercer();
  const coerce = (raw: string, type: CliArgType) => c.coerce(raw, type, 'FIELD');

  it('passes strings through unchanged', () => {
    expect(coerce('hello', 'string')).toBe('hello');
  });

  it('coerces integers, rejecting non-integers', () => {
    expect(coerce('42', 'int')).toBe(42);
    expect(() => coerce('4.5', 'int')).toThrow(/FIELD: expected an integer/);
    expect(() => coerce('x', 'int')).toThrow(/FIELD: expected an integer/);
  });

  it('coerces floats, rejecting non-numbers', () => {
    expect(coerce('4.5', 'float')).toBe(4.5);
    expect(coerce('7', 'float')).toBe(7);
    expect(() => coerce('x', 'float')).toThrow(/FIELD: expected a number/);
  });

  it('coerces booleans from true/false/1/0, rejecting anything else', () => {
    expect(coerce('true', 'boolean')).toBe(true);
    expect(coerce('1', 'boolean')).toBe(true);
    expect(coerce('FALSE', 'boolean')).toBe(false);
    expect(coerce('0', 'boolean')).toBe(false);
    expect(() => coerce('yes', 'boolean')).toThrow(/FIELD: expected a boolean/);
  });

  it('parses JSON, rejecting malformed JSON', () => {
    expect(coerce('{"a":1}', 'json')).toEqual({ a: 1 });
    expect(() => coerce('{bad', 'json')).toThrow(/FIELD: expected valid JSON/);
  });

  it('throws on an unknown value type', () => {
    expect(() => coerce('x', 'nope' as CliArgType)).toThrow(/unknown config value type "nope"/);
  });
});

describe('NexxusFileConfigProvider', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxx-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads and parses a valid JSON config file', () => {
    const file = path.join(dir, 'config.json');

    fs.writeFileSync(file, JSON.stringify({ port: 8080, name: 'nexxus' }));

    expect(new NexxusFileConfigProvider(file).getConfig()).toEqual({ port: 8080, name: 'nexxus' });
  });

  it('maps a missing file to CONFIG_FILE_NOT_FOUND', () => {
    const err = grab(() => new NexxusFileConfigProvider(path.join(dir, 'ghost.json')).getConfig());

    expect(err?.name).toBe('FatalErrorException');
    expect(err?.subcode).toBe('CONFIG_FILE_NOT_FOUND');
  });

  it('maps a non-ENOENT/permission read error (a directory) to a generic fatal error', () => {
    // Reading a directory as a file throws EISDIR — the "other error" branch.
    const err = grab(() => new NexxusFileConfigProvider(dir).getConfig());

    expect(err?.name).toBe('FatalErrorException');
    expect(err?.subcode).toBe('FATAL_ERROR'); // no specific subcode
  });

  it('maps malformed JSON to CONFIG_FILE_INVALID_JSON', () => {
    const file = path.join(dir, 'bad.json');

    fs.writeFileSync(file, '{ not valid json');

    const err = grab(() => new NexxusFileConfigProvider(file).getConfig());

    expect(err?.name).toBe('FatalErrorException');
    expect(err?.subcode).toBe('CONFIG_FILE_INVALID_JSON');
  });

  describe('unreadable file → CONFIG_FILE_UNREADABLE', () => {
    beforeAll(() => {
      if (isPosixRoot) {
        // eslint-disable-next-line no-console
        console.warn('[ConfigProvider tests] Running as root — skipping the unreadable-file test: root bypasses chmod(0o000), so the denied read cannot be reproduced.');
      }
    });

    (isPosixRoot ? it.skip : it)('wraps a denied read (EACCES on POSIX, EPERM on Windows)', () => {
      const file = path.join(dir, 'locked.json');

      fs.writeFileSync(file, JSON.stringify({ secret: true }));
      denyRead(file);

      try {
        const err = grab(() => new NexxusFileConfigProvider(file).getConfig());

        expect(err?.name).toBe('FatalErrorException');
        expect(err?.subcode).toBe('CONFIG_FILE_UNREADABLE');
      } finally {
        restoreRead(file); // so afterEach's rmSync can remove it
      }
    });
  });
});

describe('NexxusEnvVarsConfigProvider', () => {
  const added: string[] = [];

  const setEnv = (key: string, value: string) => {
    added.push(key);
    process.env[key] = value;
  };

  afterEach(() => {
    for (const key of added) {
      delete process.env[key];
    }
    added.length = 0;
  });

  it('collects only NXX_-prefixed variables, verbatim', () => {
    setEnv('NXX_PORT', '9000');
    setEnv('NXX_NAME', 'svc');
    setEnv('HOME_MADE', 'ignored'); // no prefix → excluded

    const config = new NexxusEnvVarsConfigProvider().getConfig();

    expect(config.NXX_PORT).toBe('9000');
    expect(config.NXX_NAME).toBe('svc');
    expect('HOME_MADE' in config).toBe(false);
  });
});

describe('NexxusCliArgConfigProvider', () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = process.argv;
  });

  afterEach(() => {
    process.argv = savedArgv;
  });

  it('parses registered arguments as raw strings', () => {
    process.argv = ['node', 'script', '--port', '9000'];

    const provider = new NexxusCliArgConfigProvider();

    provider.addArgument('port');

    expect(provider.getConfig().port).toBe('9000');
  });

  it('addArgument is idempotent (safe to call twice)', () => {
    process.argv = ['node', 'script', '--port', '9000'];

    const provider = new NexxusCliArgConfigProvider();

    provider.addArgument('port');

    expect(() => provider.addArgument('port')).not.toThrow();
    expect(provider.getConfig().port).toBe('9000');
  });

  it('silently ignores unrecognized arguments instead of exiting', () => {
    process.argv = ['node', 'script', '--port', '9000', '--unknown', 'x'];

    const provider = new NexxusCliArgConfigProvider();

    provider.addArgument('port');

    // The suppressed-exit hook swallows argparse's "unrecognized arguments" exit.
    expect(() => provider.getConfig()).not.toThrow();
    expect(provider.getConfig().port).toBe('9000');
  });
});

/** Run `fn`, returning the thrown error (with the Nexxus `.subcode`) or undefined. */
function grab(fn: () => unknown): (Error & { subcode?: string }) | undefined {
  try {
    fn();
  } catch (e) {
    return e as Error & { subcode?: string };
  }

  return undefined;
}

function denyRead(file: string): void {
  if (process.platform === 'win32') {
    execFileSync('icacls', [file, '/deny', `${os.userInfo().username}:(R)`]);
  } else {
    fs.chmodSync(file, 0o000);
  }
}

function restoreRead(file: string): void {
  if (process.platform === 'win32') {
    execFileSync('icacls', [file, '/remove:d', os.userInfo().username]);
  } else {
    fs.chmodSync(file, 0o600);
  }
}
