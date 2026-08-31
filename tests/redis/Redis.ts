import { describe, it, expect, beforeEach } from 'vitest';
import { NexxusRedis } from '@mayhem93/nexxus-redis';
import { NexxusBaseLogger, type INexxusBaseServices } from '@mayhem93/nexxus-core-lib';
import { rstate, fakeClient, resetRedisModule } from './redisModuleMock';

class SilentLogger extends NexxusBaseLogger<Record<string, unknown>> {
  public log(): void {}
  public async getStats(): Promise<Record<string, unknown>> { return {}; }
}

const logger = new SilentLogger({});

const makeRedis = (cfg: Record<string, unknown> = { host: 'localhost', port: 6379 }): NexxusRedis => {
  const services = { configManager: { getConfig: () => cfg }, logger } as unknown as INexxusBaseServices;

  return new NexxusRedis(services);
};

beforeEach(() => resetRedisModule());

describe('NexxusRedis construction + init', () => {
  it('throws when the logger is not a NexxusBaseLogger', () => {
    const services = { configManager: { getConfig: () => ({}) }, logger: {} } as unknown as INexxusBaseServices;

    expect(() => new NexxusRedis(services)).toThrow(/not an instance of NexxusBaseLogger/);
  });

  it('creates a single client with the configured url and connects', async () => {
    const redis = makeRedis({ host: 'db.local', port: 6380 });

    await redis.init();

    expect(rstate.created).toBe('client');
    expect(rstate.lastOptions.url).toBe('redis://db.local:6380');
    expect(rstate.lastOptions.RESP).toBe(3);
    expect(fakeClient.connect).toHaveBeenCalled();
  });

  it('creates a cluster client when cluster is enabled', async () => {
    const redis = makeRedis({ host: 'c.local', port: 7000, cluster: true });

    await redis.init();

    expect(rstate.created).toBe('cluster');
    expect(rstate.lastOptions.rootNodes[0].url).toBe('redis://c.local:7000');
  });

  it('emits connect on ready, and disconnect on end and on error', async () => {
    const redis = makeRedis();
    let connects = 0;
    let disconnects = 0;

    redis.on('connect', () => { connects += 1; });
    redis.on('disconnect', () => { disconnects += 1; });

    await redis.init();

    rstate.handlers.ready();
    rstate.handlers.end();
    rstate.handlers.error(new Error('socket died'));
    rstate.handlers.reconnecting(); // just logs — must not throw

    expect(connects).toBe(1);
    expect(disconnects).toBe(2);
  });
});

describe('NexxusRedis getClient / close', () => {
  it('getClient throws before init and returns the client after', async () => {
    const redis = makeRedis();

    expect(() => redis.getClient()).toThrow(/not initialized/);

    await redis.init();

    expect(redis.getClient()).toBe(fakeClient);
  });

  it('close closes the underlying client', async () => {
    const redis = makeRedis();

    await redis.init();
    await redis.close();

    expect(fakeClient.close).toHaveBeenCalled();
  });
});

describe('NexxusRedis getStats', () => {
  it('reports disconnected when there is no client', async () => {
    expect(await makeRedis().getStats()).toEqual({ id: 'unknown', connected: false });
  });

  it('parses INFO + DBSIZE into a stats snapshot', async () => {
    const redis = makeRedis();

    await redis.init();

    rstate.infoText = [
      '# Server', 'run_id:abc123',
      '# Memory', 'used_memory:1048576',
      '# Clients', 'connected_clients:5',
      '# CPU', 'used_cpu_sys:1.5', 'used_cpu_user:2.25',
      '', // blank line skipped
    ].join('\r\n');
    rstate.dbSize = 42;

    expect(await redis.getStats()).toEqual({
      id: 'abc123',
      connected: true,
      memoryUsedBytes: 1048576,
      connectedClients: 5,
      totalKeys: 42,
      usedCpuSys: 1.5,
      usedCpuUser: 2.25,
    });
  });

  it('falls back to disconnected when INFO throws', async () => {
    const redis = makeRedis();

    await redis.init();
    rstate.infoImpl = () => Promise.reject(new Error('INFO failed'));

    expect(await redis.getStats()).toEqual({ id: 'unknown', connected: false });
  });

  it('drops non-numeric INFO fields instead of reporting NaN', async () => {
    const redis = makeRedis();

    await redis.init();
    rstate.infoText = 'used_memory:notanumber\r\nused_cpu_sys:notafloat';

    const stats = await redis.getStats();

    expect(stats.memoryUsedBytes).toBeUndefined();
    expect(stats.usedCpuSys).toBeUndefined();
  });

  it('reports id "unknown" when run_id is absent from INFO', async () => {
    const redis = makeRedis();

    await redis.init();
    rstate.infoText = 'used_memory:100';
    rstate.dbSize = 0;

    const stats = await redis.getStats();

    expect(stats.id).toBe('unknown');
    expect(stats.memoryUsedBytes).toBe(100);
    expect(stats.connectedClients).toBeUndefined();
  });
});
