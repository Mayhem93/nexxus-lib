import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NexxusRedisScriptLoader } from '@mayhem93/nexxus-redis';
import { FakeRedis } from './fakeRedis';

let redis: FakeRedis;
let scripts: NexxusRedisScriptLoader;

/** Run the username-lock release on the lock at `lock`: 1 when it was deleted. */
const release = (token: string): Promise<0 | 1> =>
  scripts.run('username-lock-release', { keys: [ 'lock' ], args: [ token ] });

beforeEach(() => {
  redis = new FakeRedis();
  scripts = new NexxusRedisScriptLoader(() => redis as never);
});

describe('NexxusRedisScriptLoader.run', () => {
  it('sends the script once, then runs it by the SHA1 Redis answered with', async () => {
    const load = vi.spyOn(redis, 'scriptLoad');
    const evalSha = vi.spyOn(redis, 'evalSha');

    await redis.set('lock', 'tok');

    expect(await release('tok')).toBe(1);
    expect(await release('tok')).toBe(0);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(NexxusRedisScriptLoader.readSources()['username-lock-release']);

    const sha = await load.mock.results[0]!.value;

    expect(evalSha).toHaveBeenCalledTimes(2);
    expect(evalSha).toHaveBeenCalledWith(sha, { keys: [ 'lock' ], arguments: [ 'tok' ] });
  });

  it('sends the script once for concurrent first runs', async () => {
    const load = vi.spyOn(redis, 'scriptLoad');

    await Promise.all([ release('a'), release('b'), release('c') ]);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('runs a script Redis no longer holds from its source, and by SHA1 again after that', async () => {
    await release('tok');
    await redis.scriptFlush();

    const load = vi.spyOn(redis, 'scriptLoad');
    const fromSource = vi.spyOn(redis, 'eval');

    await redis.set('lock', 'tok');

    expect(await release('tok')).toBe(1);
    expect(fromSource).toHaveBeenCalledTimes(1);

    // Running it from source left it on the server.
    await release('tok');

    expect(fromSource).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it('passes on any other error, without running the script from its source', async () => {
    vi.spyOn(redis, 'evalSha').mockRejectedValueOnce(new Error('connection lost'));

    const fromSource = vi.spyOn(redis, 'eval');

    await expect(release('tok')).rejects.toThrow('connection lost');
    expect(fromSource).not.toHaveBeenCalled();
  });

  it('sends the script again on the next run when sending it failed', async () => {
    const load = vi.spyOn(redis, 'scriptLoad').mockRejectedValueOnce(new Error('connection lost'));

    await expect(release('tok')).rejects.toThrow('connection lost');

    await redis.set('lock', 'tok');

    expect(await release('tok')).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('NexxusRedisScriptLoader.reset', () => {
  it('sends each script again before its next run', async () => {
    const load = vi.spyOn(redis, 'scriptLoad');

    await release('tok');
    scripts.reset();
    await release('tok');

    expect(load).toHaveBeenCalledTimes(2);
  });

  /**
   * A send still in flight at the reset may fail after the next one started.
   * Forgetting the failed one must not forget the newer one too.
   */
  it('keeps the send started after it when the one before it fails', async () => {
    let failFirstSend!: (e: Error) => void;

    const load = vi.spyOn(redis, 'scriptLoad').mockImplementationOnce(
      () => new Promise<string>((_resolve, reject) => { failFirstSend = reject; })
    );

    const first = release('tok');

    scripts.reset();

    const second = release('tok');

    failFirstSend(new Error('connection lost'));

    await expect(first).rejects.toThrow('connection lost');
    await second;
    await release('tok');

    expect(load).toHaveBeenCalledTimes(2);
  });
});
