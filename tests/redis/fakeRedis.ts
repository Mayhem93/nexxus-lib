/**
 * A small STATEFUL in-memory Redis for the model tests. Implements only the
 * commands the models actually use, with real state semantics (SADD returns the
 * count of NEW members, SCARD reflects the set, HINCRBY returns the new value,
 * etc.) so multi-step lifecycles (partition counting, scope decrement-to-zero
 * cleanup) are exercised for real. TTL is not modeled (expire is a no-op that
 * only reports whether the key exists). The JSON namespace supports the paths
 * the models use: '$' (whole doc), '$.session' and a connection's entry,
 * `$.connections['<id>']`. Scripting holds scripts by SHA1
 * as Redis does (SCRIPT LOAD, EVALSHA, EVAL) and runs the ones the models use,
 * recognised by their source.
 */
import { NexxusRedisScriptLoader, type NexxusRedisScriptName } from '@mayhem93/nexxus-redis';

import { createHash } from 'node:crypto';

type ScriptOptions = { keys: string[]; arguments: string[] };

type Entry =
  | { type: 'hash'; value: Map<string, string> }
  | { type: 'set'; value: Set<string> }
  | { type: 'json'; value: any }
  /** `ttl` records what SET was asked for; expiry itself isn't simulated. */
  | { type: 'string'; value: string; ttl?: number };

export class FakeRedis {
  /** Each script's name, by its source: how a script sent here is recognised. */
  private static readonly SCRIPT_NAMES = new Map(
    Object.entries(NexxusRedisScriptLoader.readSources())
      .map(([ name, source ]) => [ source, name as NexxusRedisScriptName ])
  );

  /** A connection's entry path, `$.connections['<id>']`, capturing the id. */
  private static readonly CONNECTION_PATH = /^\$\.connections\['([^']+)'\]$/;

  public store = new Map<string, Entry>();

  /**
   * The scripts this server holds, by SHA1. ES-private because the worker
   * harness deletes every own property between tests, to drop per-test
   * overrides.
   */
  readonly #scripts = new Map<string, string>();

  /**
   * Runs at the start of the next device script, before it reads anything —
   * lets a test land a competing write between a caller's read and its
   * compare-and-set.
   */
  public beforeEval: (() => void) | null = null;

  private hash(key: string): Map<string, string> {
    let e = this.store.get(key);

    if (!e) {
      e = { type: 'hash', value: new Map() };
      this.store.set(key, e);
    }

    return (e as { value: Map<string, string> }).value;
  }

  private setOf(key: string): Set<string> {
    let e = this.store.get(key);

    if (!e) {
      e = { type: 'set', value: new Set() };
      this.store.set(key, e);
    }

    return (e as { value: Set<string> }).value;
  }

  // ---- STRING ----
  async set(
    key: string,
    value: string,
    opts?: { condition?: 'NX'; expiration?: { type: string; value: number } }
  ): Promise<string | null> {
    if (opts?.condition === 'NX' && this.store.has(key)) {
      return null;
    }

    this.store.set(key, { type: 'string', value, ttl: opts?.expiration?.value });

    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);

    return e?.type === 'string' ? e.value : null;
  }

  /** Atomic read-and-delete, which is what makes a nonce single-use. */
  async getDel(key: string): Promise<string | null> {
    const e = this.store.get(key);

    if (e?.type !== 'string') {
      return null;
    }

    this.store.delete(key);

    return e.value;
  }

  // ---- HASH ----
  async hSet(key: string, fieldOrObj: string | Record<string, string>, val?: string): Promise<number> {
    const h = this.hash(key);
    let added = 0;

    if (typeof fieldOrObj === 'object') {
      for (const [f, v] of Object.entries(fieldOrObj)) {
        if (!h.has(f)) added += 1;
        h.set(f, v);
      }
    } else {
      if (!h.has(fieldOrObj)) added += 1;
      h.set(fieldOrObj, val as string);
    }

    return added;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const e = this.store.get(key);

    return e ? Object.fromEntries((e as { value: Map<string, string> }).value) : {};
  }

  async hmGet(key: string, fields: string[]): Promise<Array<string | null>> {
    const e = this.store.get(key);
    const h = e ? (e as { value: Map<string, string> }).value : undefined;

    return fields.map(f => h?.get(f) ?? null);
  }

  async hIncrBy(key: string, field: string, n: number): Promise<number> {
    const h = this.hash(key);
    const next = parseInt(h.get(field) ?? '0', 10) + n;

    h.set(field, String(next));

    return next;
  }

  async hDel(key: string, field: string): Promise<number> {
    const e = this.store.get(key);

    if (!e) return 0;

    const h = (e as { value: Map<string, string> }).value;
    const had = h.delete(field);

    if (h.size === 0) this.store.delete(key);

    return had ? 1 : 0;
  }

  async hKeys(key: string): Promise<string[]> {
    const e = this.store.get(key);

    return e ? [...(e as { value: Map<string, string> }).value.keys()] : [];
  }

  async expire(key: string, _seconds: number): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  // ---- SET ----
  async sAdd(key: string, member: string): Promise<number> {
    const s = this.setOf(key);
    const had = s.has(member);

    s.add(member);

    return had ? 0 : 1;
  }

  async sRem(key: string, member: string): Promise<number> {
    const e = this.store.get(key);

    if (!e) return 0;

    const s = (e as { value: Set<string> }).value;
    const had = s.delete(member);

    if (s.size === 0) this.store.delete(key);

    return had ? 1 : 0;
  }

  async sCard(key: string): Promise<number> {
    const e = this.store.get(key);

    return e ? (e as { value: Set<string> }).value.size : 0;
  }

  async sMembers(key: string): Promise<string[]> {
    const e = this.store.get(key);

    return e ? [...(e as { value: Set<string> }).value] : [];
  }

  async unlink(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  // ---- SCRIPTING ----
  /** Holds the script and answers with its SHA1, as Redis does. */
  async scriptLoad(source: string): Promise<string> {
    const sha = FakeRedis.sha1(source);

    this.#scripts.set(sha, source);

    return sha;
  }

  /** Drops every script held, as a Redis restart or SCRIPT FLUSH does. */
  async scriptFlush(): Promise<string> {
    this.#scripts.clear();

    return 'OK';
  }

  /** Runs a script held here; refuses one that isn't, with Redis's NOSCRIPT error. */
  async evalSha(sha: string, opts: ScriptOptions): Promise<number | string | null> {
    const source = this.#scripts.get(sha);

    if (source === undefined) {
      throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    }

    return this.runScript(source, opts);
  }

  /** Runs a script from its source, and holds it from then on, as Redis does. */
  async eval(source: string, opts: ScriptOptions): Promise<number | string | null> {
    this.#scripts.set(FakeRedis.sha1(source), source);

    return this.runScript(source, opts);
  }

  /**
   * Emulates each script with its own return contract. The username-lock
   * release: 1 deleted, 0 the lock holds another token (or is gone). The
   * device-session compare-and-set: 1 swapped, 0 the stored hash moved on (or
   * there is no session), -1 no such device. The counter release: what is left
   * on the counter. The connection scripts: see `runConnectionScript`. Any
   * other script is refused, so a new one can't silently hit a fake that does
   * nothing.
   */
  private runScript(source: string, opts: ScriptOptions): number | string | null {
    const name = FakeRedis.SCRIPT_NAMES.get(source);

    if (name?.startsWith('connection-')) {
      return this.runConnectionScript(name, opts);
    }

    // One off the counter; at zero it goes, with the fields named after it.
    if (name === 'counter-release') {
      const [ counter, ...alongside ] = opts.arguments as [ string, ...string[] ];
      const hash = this.hash(opts.keys[0]!);
      const count = parseInt(hash.get(counter) ?? '0', 10) - 1;

      if (count > 0) {
        hash.set(counter, String(count));
      } else {
        for (const field of [ counter, ...alongside ]) {
          hash.delete(field);
        }

        // As Redis does, a hash with no fields left is deleted.
        if (hash.size === 0) {
          this.store.delete(opts.keys[0]!);
        }
      }

      return count;
    }

    if (name === 'username-lock-release') {
      const lock = this.store.get(opts.keys[0]!);

      if (lock?.type !== 'string' || lock.value !== opts.arguments[0]) return 0;

      this.store.delete(opts.keys[0]!);

      return 1;
    }

    if (name !== 'device-session-cas') {
      throw new Error('FakeRedis: unsupported script');
    }

    this.beforeEval?.();

    const e = this.store.get(opts.keys[0]!);

    if (!e) return -1;

    const doc = (e as { value: any }).value;

    if (doc.session?.hash !== opts.arguments[0]) return 0;

    doc.session = JSON.parse(opts.arguments[1]!);

    return 1;
  }

  /**
   * The connection scripts, each acting on the entry its first argument's path
   * names. Open: 1 open (an entry already there is kept), 0 the session has
   * ended or expired, -1 no such device. Subscribe: the transport once the
   * channel is listed, -2 no entry or a closing one, -1 no such device.
   * Unsubscribe: 1 removed, 0 not listed, -2 no entry, -1 no such device.
   * Close: the entry as it was, inside a JSON list, now marked closing; null
   * when there is none.
   */
  private runConnectionScript(name: NexxusRedisScriptName, opts: ScriptOptions): number | string | null {
    this.beforeEval?.();

    const device = this.store.get(opts.keys[0]!) as { value: any } | undefined;
    const id = FakeRedis.connectionId(opts.arguments[0]!);
    const entry = device?.value.connections?.[id];

    switch (name) {
      case 'connection-open': {
        if (!device) return -1;

        const expiresAt = device.value.session?.expiresAt;

        if (expiresAt === undefined || expiresAt <= Number(opts.arguments[2])) return 0;

        device.value.connections ??= {};
        device.value.connections[id] ??= JSON.parse(opts.arguments[1]!);
        device.value.lastSeen = JSON.parse(opts.arguments[3]!);

        return 1;
      }

      case 'connection-subscribe': {
        if (!device) return -1;
        if (!entry || entry.closing) return -2;

        const channel = JSON.parse(opts.arguments[1]!);

        if (!entry.subscriptions.includes(channel)) {
          entry.subscriptions.push(channel);
        }

        return entry.transport;
      }

      case 'connection-unsubscribe': {
        if (!device) return -1;
        if (!entry) return -2;

        const i = entry.subscriptions.indexOf(JSON.parse(opts.arguments[1]!));

        if (i === -1) return 0;

        entry.subscriptions.splice(i, 1);

        return 1;
      }

      case 'connection-close': {
        if (!entry) return null;

        const before = JSON.stringify([ entry ]);

        entry.closing = true;

        return before;
      }

      default:
        throw new Error('FakeRedis: unsupported script');
    }
  }

  /** The connection id inside an entry path, `$.connections['<id>']`. */
  private static connectionId(path: string): string {
    const match = FakeRedis.CONNECTION_PATH.exec(path);

    if (!match) {
      throw new Error(`FakeRedis: not a connection path: ${path}`);
    }

    return match[1]!;
  }

  private static sha1(source: string): string {
    return createHash('sha1').update(source).digest('hex');
  }

  // ---- JSON ----
  public json = {
    get: async (key: string, opts?: { path?: string }): Promise<any> => {
      const e = this.store.get(key);

      if (!e) return null;

      // Every read is a copy, as one from a real server is: the caller can't
      // reach into the store, or see it change after the read.
      const obj = structuredClone((e as { value: any }).value);

      // Faithful to real RedisJSON: a JSONPath read returns an ARRAY of matches,
      // empty when the path matches nothing.
      if (opts?.path === '$.session') {
        return obj.session === undefined ? [] : [ obj.session ];
      }

      const connection = FakeRedis.CONNECTION_PATH.exec(opts?.path ?? '');

      if (connection) {
        const entry = obj.connections?.[connection[1]!];

        return entry === undefined ? [] : [ entry ];
      }

      return obj;
    },
    set: async (key: string, path: string, value: any, opts?: { condition?: 'NX' | 'XX' }): Promise<string | null> => {
      const e = this.store.get(key);

      if (path === '$') {
        if (opts?.condition === 'NX' && e) return null;
        if (opts?.condition === 'XX' && !e) return null;

        this.store.set(key, { type: 'json', value });

        return 'OK';
      }

      // Real RedisJSON refuses to create a new document from a nested path.
      if (!e) {
        throw new Error('ERR new objects must be created at the root');
      }

      (e as { value: any }).value[path.replace('$.', '')] = value;

      return 'OK';
    },
    del: async (key: string, opts?: { path?: string }): Promise<number> => {
      const e = this.store.get(key);

      if (!e) return 0;

      const doc = (e as { value: any }).value;
      const connection = FakeRedis.CONNECTION_PATH.exec(opts?.path ?? '');

      if (connection) {
        if (doc.connections?.[connection[1]!] === undefined) return 0;

        delete doc.connections[connection[1]!];

        return 1;
      }

      const field = (opts?.path ?? '$').replace('$.', '');

      if (!(field in doc)) return 0;

      delete doc[field];

      return 1;
    },
    mSet: async (updates: Array<{ key: string; path: string; value: any }>): Promise<string | null> => {
      for (const u of updates) {
        const e = this.store.get(u.key);

        if (!e) return null;

        const field = u.path.replace('$.', '');

        (e as { value: any }).value[field] = u.value;
      }

      return 'OK';
    },
  };
}
