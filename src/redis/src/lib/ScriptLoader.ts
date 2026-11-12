import type * as Redis from 'redis';

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every Lua script Nexxus runs, by name: the KEYS and ARGV it takes, in order,
 * and what it returns. The script's file says what each value means.
 */
export type NexxusRedisScripts = {
  'device-session-cas': {
    keys: [ device: string ];
    args: [ expectedHash: string, sessionJson: string ];
    result: -1 | 0 | 1;
  };
  'connection-open': {
    keys: [ device: string ];
    args: [ connectionPath: string, connectionJson: string, nowSeconds: string, lastSeenJson: string ];
    result: -1 | 0 | 1;
  };
  'connection-subscribe': {
    keys: [ device: string ];
    args: [ connectionPath: string, channelJson: string ];
    /** The connection's transport, when the channel is listed. */
    result: -2 | -1 | string;
  };
  'connection-unsubscribe': {
    keys: [ device: string ];
    args: [ connectionPath: string, channelJson: string ];
    result: -2 | -1 | 0 | 1;
  };
  'connection-close': {
    keys: [ device: string ];
    args: [ connectionPath: string ];
    /** The entry before the call, inside a JSON list. */
    result: string | null;
  };
  'counter-release': {
    keys: [ hash: string ];
    args: [ counter: string, ...deletedAlongside: string[] ];
    /** What is left on the counter. */
    result: number;
  };
  'username-lock-release': {
    keys: [ lock: string ];
    args: [ token: string ];
    result: 0 | 1;
  };
};

export type NexxusRedisScriptName = keyof NexxusRedisScripts;

/** What a script runs with: its KEYS and its ARGV. */
export type NexxusRedisScriptInput<N extends NexxusRedisScriptName> = Pick<NexxusRedisScripts[N], 'keys' | 'args'>;

type NexxusRedisClient = Redis.RedisClientType | Redis.RedisClusterType;

/**
 * The Lua scripts Nexxus runs, read from `src/lib/scripts` when the loader is
 * created, so a missing file fails at boot rather than on first use.
 *
 * Each script is sent to Redis once per connection, with SCRIPT LOAD, and from
 * then on run by the SHA1 Redis answered with. Redis can lose a script without
 * this connection dropping: a SCRIPT FLUSH, a failover, or, on a cluster, a
 * node that was never sent it. A script Redis doesn't hold is run once from its
 * source, which leaves it on that node.
 *
 * A script touches only the keys it is given, and they share one slot, so it
 * runs unchanged on a cluster.
 */
export class NexxusRedisScriptLoader {
  /** Where each script lives, under `src/lib/scripts`. */
  private static readonly LOCATIONS: Readonly<Record<NexxusRedisScriptName, string>> = {
    'device-session-cas': 'device-session-cas.lua',
    'connection-open': 'connection-open.lua',
    'connection-subscribe': 'connection-subscribe.lua',
    'connection-unsubscribe': 'connection-unsubscribe.lua',
    'connection-close': 'connection-close.lua',
    'counter-release': 'counter-release.lua',
    'username-lock-release': 'username-lock-release.lua'
  };

  /** tsc doesn't copy `.lua` files, so the builds read them from `src` too. */
  private static readonly SCRIPTS_DIR = path.join(__dirname, '../../src/lib/scripts');

  private readonly sources: Readonly<Record<NexxusRedisScriptName, string>>;

  /**
   * Each script's SHA1, from the SCRIPT LOAD sent on this connection. Stored
   * while that is still in flight, so concurrent first runs share it.
   */
  private readonly shas = new Map<NexxusRedisScriptName, Promise<string>>();

  constructor(private readonly getClient: () => NexxusRedisClient) {
    this.sources = NexxusRedisScriptLoader.readSources();
  }

  /** Every script's source, by name. Throws when a file is missing. */
  public static readSources(): Record<NexxusRedisScriptName, string> {
    const sources = {} as Record<NexxusRedisScriptName, string>;

    for (const [ name, location ] of Object.entries(NexxusRedisScriptLoader.LOCATIONS)) {
      sources[name as NexxusRedisScriptName] = fs.readFileSync(
        path.join(NexxusRedisScriptLoader.SCRIPTS_DIR, location),
        'utf8'
      );
    }

    return sources;
  }

  /** Run a script and return its result. */
  public async run<N extends NexxusRedisScriptName>(
    name: N,
    input: NexxusRedisScriptInput<N>
  ): Promise<NexxusRedisScripts[N]['result']> {
    const options = { keys: input.keys, arguments: input.args };
    const sha = await this.load(name);

    try {
      return await this.getClient().evalSha(sha, options) as NexxusRedisScripts[N]['result'];
    } catch (e) {
      if (!NexxusRedisScriptLoader.isMissingScript(e)) {
        throw e;
      }

      return await this.getClient().eval(this.sources[name], options) as NexxusRedisScripts[N]['result'];
    }
  }

  /**
   * Forget which scripts were sent, so each is sent again before its next run.
   * For when the connection drops: a restarted Redis holds none.
   */
  public reset(): void {
    this.shas.clear();
  }

  /** The script's SHA1, sending the script first if this connection hasn't yet. */
  private load(name: NexxusRedisScriptName): Promise<string> {
    const known = this.shas.get(name);

    if (known) {
      return known;
    }

    const loading = this.getClient().scriptLoad(this.sources[name]) as Promise<string>;

    this.shas.set(name, loading);

    // Forgotten when it fails, so the next run sends the script again.
    loading.catch(() => {
      if (this.shas.get(name) === loading) {
        this.shas.delete(name);
      }
    });

    return loading;
  }

  /** How Redis answers EVALSHA for a script it doesn't hold. */
  private static isMissingScript(e: unknown): boolean {
    return e instanceof Error && e.message.startsWith('NOSCRIPT');
  }
}
