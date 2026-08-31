/**
 * A small STATEFUL in-memory Redis for the model tests. Implements only the
 * commands the models actually use, with real state semantics (SADD returns the
 * count of NEW members, SCARD reflects the set, HINCRBY returns the new value,
 * etc.) so multi-step lifecycles (partition counting, scope decrement-to-zero
 * cleanup) are exercised for real. TTL is not modeled (expire is a no-op that
 * only reports whether the key exists). The JSON namespace supports the two
 * paths the models use: '$' (whole doc) and '$.subscriptions'.
 */
type Entry =
  | { type: 'hash'; value: Map<string, string> }
  | { type: 'set'; value: Set<string> }
  | { type: 'json'; value: any };

export class FakeRedis {
  public store = new Map<string, Entry>();

  private hash(key: string): Map<string, string> {
    let e = this.store.get(key);

    if (!e) {
      e = { type: 'hash', value: new Map() };
      this.store.set(key, e);
    }

    return (e as { value: Map<string, string> }).value;
  }

  private set(key: string): Set<string> {
    let e = this.store.get(key);

    if (!e) {
      e = { type: 'set', value: new Set() };
      this.store.set(key, e);
    }

    return (e as { value: Set<string> }).value;
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
    const s = this.set(key);
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

  // ---- JSON ----
  public json = {
    get: async (key: string, opts?: { path?: string }): Promise<any> => {
      const e = this.store.get(key);

      if (!e) return null;

      const obj = (e as { value: any }).value;

      if (opts?.path === '$.subscriptions') {
        return obj.subscriptions ?? null;
      }

      return obj;
    },
    set: async (key: string, _path: string, value: any): Promise<string> => {
      this.store.set(key, { type: 'json', value });

      return 'OK';
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
    arrAppend: async (key: string, _path: string, value: any): Promise<number | null> => {
      const e = this.store.get(key);

      if (!e) return null;

      (e as { value: any }).value.subscriptions.push(value);

      return (e as { value: any }).value.subscriptions.length;
    },
    arrPop: async (key: string, opts: { path: string; index: number }): Promise<any> => {
      const e = this.store.get(key);

      if (!e) return null;

      const arr = (e as { value: any }).value.subscriptions as any[];

      if (opts.index < 0 || opts.index >= arr.length) return null;

      return arr.splice(opts.index, 1)[0];
    },
    clear: async (key: string, _opts: { path: string }): Promise<number> => {
      const e = this.store.get(key);

      if (e) {
        (e as { value: any }).value.subscriptions = [];
      }

      return 1;
    },
  };
}
