import { describe, it, expect, afterAll } from 'vitest';
import {
  NexxusBaseLogger,
  WinstonNexxusLogger,
  NexxusLoggerLevels,
  type LogAttributes
} from '@mayhem93/nexxus-core-lib';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** file:// URL for a fixture module (a valid dynamic-import specifier cross-platform). */
const fixtureUrl = (name: string) => pathToFileURL(path.resolve('tests/fixtures', name)).href;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxx-log-'));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * NexxusBaseLogger — pure helpers + the convenience→dispatch→log path *
 * ------------------------------------------------------------------ */

/** Captures every log() call so we can assert how the convenience methods route. */
type Call = { level: NexxusLoggerLevels; message: string; attributes?: LogAttributes; label?: string };

class TestLogger extends NexxusBaseLogger<Record<string, unknown>> {
  public calls: Call[] = [];

  public log(level: NexxusLoggerLevels, message: string, attributes?: LogAttributes, label?: string): void {
    this.calls.push({ level, message, attributes, label });
  }

  public async getStats(): Promise<Record<string, unknown>> {
    return {};
  }

  // Expose the protected static serialization helpers for direct testing.
  public static exposeSerializeError(err: Error): Record<string, unknown> {
    return this.serializeError(err);
  }

  public static exposeSafeStringify(value: unknown): string {
    return this.safeStringify(value);
  }
}

describe('NexxusBaseLogger serialization helpers', () => {
  it('serializeError captures name/message/stack, and cause when present', () => {
    const plain = TestLogger.exposeSerializeError(new Error('boom'));

    expect(plain).toMatchObject({ name: 'Error', message: 'boom' });
    expect(typeof plain.stack).toBe('string');
    expect('cause' in plain).toBe(false);

    const withCause = TestLogger.exposeSerializeError(new Error('outer', { cause: 'inner' }));

    expect(withCause.cause).toBe('inner');
  });

  it('safeStringify serializes Errors via serializeError', () => {
    const json = JSON.parse(TestLogger.exposeSafeStringify({ err: new Error('nope') }));

    expect(json.err).toMatchObject({ name: 'Error', message: 'nope' });
  });

  it('safeStringify replaces circular references with [circular]', () => {
    const a: Record<string, unknown> = { name: 'a' };

    a.self = a;

    expect(JSON.parse(TestLogger.exposeSafeStringify(a))).toEqual({ name: 'a', self: '[circular]' });
  });

  it('safeStringify passes plain values through', () => {
    expect(TestLogger.exposeSafeStringify({ x: 1, y: 'two' })).toBe('{"x":1,"y":"two"}');
  });
});

describe('NexxusBaseLogger convenience methods', () => {
  it('routes each level method to log() with the right level', () => {
    const logger = new TestLogger({});

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.critical('c');
    logger.alert('a');
    logger.emerg('em');

    expect(logger.calls.map(c => c.level)).toEqual([
      NexxusLoggerLevels.DEBUG,
      NexxusLoggerLevels.INFO,
      NexxusLoggerLevels.WARNING,
      NexxusLoggerLevels.ERROR,
      NexxusLoggerLevels.CRITICAL,
      NexxusLoggerLevels.ALERT,
      NexxusLoggerLevels.EMERGENCY,
    ]);
  });

  it('dispatch treats a 2nd string arg as the label (no attributes)', () => {
    const logger = new TestLogger({});

    logger.info('msg', 'my-label');

    expect(logger.calls[0]).toEqual({ level: NexxusLoggerLevels.INFO, message: 'msg', attributes: undefined, label: 'my-label' });
  });

  it('dispatch treats a 2nd object arg as attributes, 3rd as label', () => {
    const logger = new TestLogger({});

    logger.info('msg', { a: 1 }, 'lbl');

    expect(logger.calls[0]).toEqual({ level: NexxusLoggerLevels.INFO, message: 'msg', attributes: { a: 1 }, label: 'lbl' });
  });
});

/* ------------------------------------------------------------------ *
 * WinstonNexxusLogger — real Winston                                  *
 * ------------------------------------------------------------------ */

const makeConfig = (over: Record<string, unknown> = {}) => ({
  level: NexxusLoggerLevels.DEBUG,
  logType: 'json',
  timestamps: false,
  colors: false,
  ...over,
});

/** A services stand-in that just feeds the logger config through configManager. */
const services = (cfg: Record<string, unknown>) => ({
  configManager: { getConfig: () => cfg },
} as never);

/**
 * Run `run` with the process output streams overridden, capturing the raw bytes
 * the real Console transport writes. IMPORTANT: the logger must be *created
 * inside* `run` — Winston's Console transport captures its stream reference at
 * construction, so a logger built before the override would bypass it. We
 * override BOTH stdout and stderr (Winston routes some levels to stderr) by
 * direct assignment (a vi.spyOn wrapper can be bypassed the same way). Winston
 * flushes on a later tick, so we wait a macrotask before restoring. Returns a
 * Buffer so tests can inspect decoded text (`.toString()`) or bytes (ANSI escapes).
 */
async function captureOutput(run: () => void | Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const grab = ((chunk: unknown) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));

    return true;
  }) as typeof process.stdout.write;

  // Winston's Console transport writes to console._stdout/_stderr (Node's
  // aliases for the process streams), not process.stdout directly, so patch
  // every real target — deduped by identity so the same stream isn't wrapped twice.
  const c = console as unknown as { _stdout?: NodeJS.WriteStream; _stderr?: NodeJS.WriteStream };
  const restores: Array<() => void> = [];
  const seen = new Set<NodeJS.WriteStream>();
  const patch = (stream?: NodeJS.WriteStream) => {
    if (stream && typeof stream.write === 'function' && !seen.has(stream)) {
      seen.add(stream);
      const orig = stream.write.bind(stream);

      stream.write = grab;
      restores.push(() => { stream.write = orig; });
    }
  };

  patch(c._stdout);
  patch(c._stderr);
  patch(process.stdout);
  patch(process.stderr);

  try {
    await run();
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    restores.forEach(fn => fn());
  }

  return Buffer.concat(chunks);
}

describe('WinstonNexxusLogger.createFallback', () => {
  it('builds a stdout json logger with the fallback config', async () => {
    const logger = WinstonNexxusLogger.createFallback();
    const stats = await logger.getStats();

    expect(stats.level).toBe(NexxusLoggerLevels.DEBUG);
    expect(stats.logType).toBe('json');
    expect(stats.transports).toEqual(['console']);
  });
});

describe('WinstonNexxusLogger.create — transports', () => {
  it('defaults to a single console transport when none are configured', async () => {
    const logger = await WinstonNexxusLogger.create(services(makeConfig()));

    expect((await logger.getStats()).transports).toEqual(['console']);
  });

  it('builds a file transport writing to the configured path', async () => {
    const filename = path.join(dir, 'out.log');
    const logger = await WinstonNexxusLogger.create(services(makeConfig({
      transports: [{ type: 'file', filename }],
    })));

    expect((await logger.getStats()).transports).toEqual(['file']);
  });

  it('rejects an unresolvable custom transport package with InvalidConfigException', async () => {
    await expect(WinstonNexxusLogger.create(services(makeConfig({
      transports: [{ type: 'this-transport-pkg-does-not-exist-xyz' }],
    })))).rejects.toThrow(/could not be loaded/);
  });

  it('loads a custom transport via its default export', async () => {
    const logger = await WinstonNexxusLogger.create(services(makeConfig({
      transports: [{ type: fixtureUrl('customTransport.mjs') }],
    })));

    expect((await logger.getStats()).transports).toContain('MyTransport');
  });

  it('loads a custom transport via a named export', async () => {
    const logger = await WinstonNexxusLogger.create(services(makeConfig({
      transports: [{ type: fixtureUrl('customTransport.mjs'), export: 'MyTransport' }],
    })));

    expect((await logger.getStats()).transports).toContain('MyTransport');
  });

  it('rejects when the named export is missing', async () => {
    await expect(WinstonNexxusLogger.create(services(makeConfig({
      transports: [{ type: fixtureUrl('customTransport.mjs'), export: 'Nope' }],
    })))).rejects.toThrow(/has no export named "Nope"/);
  });

  it('rejects when no transport class can be found in the package', async () => {
    await expect(WinstonNexxusLogger.create(services(makeConfig({
      transports: [{ type: fixtureUrl('notATransport.mjs') }],
    })))).rejects.toThrow(/Could not find a transport class/);
  });
});

describe('WinstonNexxusLogger.create — json format', () => {
  it('emits a json record with level/label/msg (defaults label, omits empty attrs)', async () => {
    const out = (await captureOutput(async () => {
      const logger = await WinstonNexxusLogger.create(services(makeConfig({ logType: 'json' })));

      logger.log(NexxusLoggerLevels.INFO, 'hello');
    })).toString();

    expect(JSON.parse(out.trim())).toEqual({ level: 'info', label: 'default-label', msg: 'hello' });
  });

  it('includes attrs and a timestamp when configured', async () => {
    const out = (await captureOutput(async () => {
      const logger = await WinstonNexxusLogger.create(services(makeConfig({ logType: 'json', timestamps: true })));

      logger.log(NexxusLoggerLevels.INFO, 'hi', { userId: 'u1' }, 'auth');
    })).toString();
    const record = JSON.parse(out.trim());

    expect(record).toMatchObject({ level: 'info', label: 'auth', msg: 'hi', attrs: { userId: 'u1' } });
    expect(typeof record.time).toBe('string');
  });
});

describe('WinstonNexxusLogger.create — text format', () => {
  it('emits a text header, appending attrs on their own lines', async () => {
    const out = (await captureOutput(async () => {
      const logger = await WinstonNexxusLogger.create(services(makeConfig({ logType: 'text' })));

      logger.log(NexxusLoggerLevels.WARNING, 'careful', { code: 7 }, 'sys');
    })).toString();

    expect(out).toContain('WARNING [sys]: careful');
    expect(out).toContain('code: 7');
  });

  it('uses default-label and no attr lines for a bare message', async () => {
    const out = (await captureOutput(async () => {
      const logger = await WinstonNexxusLogger.create(services(makeConfig({ logType: 'text' })));

      logger.log(NexxusLoggerLevels.INFO, 'plain');
    })).toString();

    expect(out.trim()).toBe('INFO [default-label]: plain');
  });

  it('prefixes a timestamp when enabled', async () => {
    const out = (await captureOutput(async () => {
      const logger = await WinstonNexxusLogger.create(services(makeConfig({ logType: 'text', timestamps: true })));

      logger.log(NexxusLoggerLevels.INFO, 'stamped');
    })).toString();

    expect(out).toMatch(/^\[[^\]]+\] INFO \[default-label\]: stamped/);
  });

  it('colorizes the level when colors are enabled', async () => {
    const out = await captureOutput(async () => {
      const logger = await WinstonNexxusLogger.create(services(makeConfig({ logType: 'text', colors: true })));

      logger.log(NexxusLoggerLevels.ERROR, 'red');
    });

    // colorize prefixes the level with an ANSI escape sequence: ESC (0x1b) then '[' (0x5b).
    expect(out[0]).toBe(0x1b);
    expect(out[1]).toBe(0x5b);
  });
});
