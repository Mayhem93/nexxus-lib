import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { NexxusRabbitMqBootstrapper, NexxusMessageQueueAdapter } from '@mayhem93/nexxus-message-queue-lib';
import { NexxusBaseLogger } from '@mayhem93/nexxus-core-lib';

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Silent logger for the static the bootstrapper logs through. */
class SilentLogger extends NexxusBaseLogger<Record<string, unknown>> {
  public log(): void {}
  public async getStats(): Promise<Record<string, unknown>> { return {}; }
}

beforeAll(() => {
  (NexxusMessageQueueAdapter as unknown as { logger: unknown }).logger = new SilentLogger({});
});

type RecordedPut = { method?: string; url?: string; auth?: string; body?: unknown };
type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function startMgmtServer(): Promise<{
  host: string;
  port: number;
  puts: RecordedPut[];
  setResponder: (r: Responder | null) => void;
  close: () => void;
}> {
  const puts: RecordedPut[] = [];
  let responder: Responder | null = null;

  const server = http.createServer((req, res) => {
    let body = '';

    req.on('data', c => { body += c; });
    req.on('end', () => {
      puts.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: body ? JSON.parse(body) : undefined,
      });

      if (responder) {
        responder(req, res);

        return;
      }

      res.writeHead(204);
      res.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, resolve));

  return {
    host: '127.0.0.1',
    port: (server.address() as AddressInfo).port,
    puts,
    setResponder: r => { responder = r; },
    close: () => server.close(),
  };
}

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  servers.forEach(s => s.close());
  servers.length = 0;
});

const OPTIONS = { runtimeUser: 'runtime', runtimePassword: 'runtime-pw' };

const makeBootstrapper = (host: string, port: number) =>
  new NexxusRabbitMqBootstrapper(OPTIONS, {
    host,
    managementPort: port,
    user: 'admin',
    password: 'admin-pw',
  });

describe('NexxusRabbitMqBootstrapper.bootstrapDeployment', () => {
  it('declares vhost, user, permissions, exchange, and per-stage queues in order', async () => {
    const srv = await startMgmtServer();

    servers.push(srv);

    await makeBootstrapper(srv.host, srv.port).bootstrapDeployment(['writer', 'aggregator']);

    expect(srv.puts.map(p => p.url)).toEqual([
      '/api/vhosts/%2Fnexxus',
      '/api/users/runtime',
      '/api/permissions/%2Fnexxus/runtime',
      '/api/exchanges/%2Fnexxus/systemMessages',
      '/api/queues/%2Fnexxus/writer',
      '/api/queues/%2Fnexxus/aggregator',
    ]);
    expect(srv.puts.every(p => p.method === 'PUT')).toBe(true);
  });

  it('sends Basic auth built from the admin credentials', async () => {
    const srv = await startMgmtServer();

    servers.push(srv);

    await makeBootstrapper(srv.host, srv.port).bootstrapDeployment([]);

    const expected = 'Basic ' + Buffer.from('admin:admin-pw').toString('base64');

    expect(srv.puts[0].auth).toBe(expected);
  });

  it('sends the expected declaration bodies', async () => {
    const srv = await startMgmtServer();

    servers.push(srv);

    await makeBootstrapper(srv.host, srv.port).bootstrapDeployment(['writer']);

    const byUrl = Object.fromEntries(srv.puts.map(p => [p.url, p.body]));

    expect(byUrl['/api/users/runtime']).toEqual({ password: 'runtime-pw', tags: '' });
    expect(byUrl['/api/permissions/%2Fnexxus/runtime']).toEqual({ configure: '.*', write: '.*', read: '.*' });
    expect(byUrl['/api/exchanges/%2Fnexxus/systemMessages']).toEqual({ type: 'fanout', durable: true });
    expect(byUrl['/api/queues/%2Fnexxus/writer']).toEqual({ durable: true, arguments: { 'x-queue-type': 'quorum' } });
  });

  it('skips dynamic-pattern stages (their per-slot queues are worker-declared)', async () => {
    const srv = await startMgmtServer();

    servers.push(srv);

    await makeBootstrapper(srv.host, srv.port).bootstrapDeployment(['writer', 'websockets-transport', 'mqtt-transport']);

    const queueUrls = srv.puts.filter(p => p.url?.startsWith('/api/queues/')).map(p => p.url);

    expect(queueUrls).toEqual(['/api/queues/%2Fnexxus/writer']); // no dynamic-stage queues
  });

  it('throws with the broker error detail on a non-2xx response', async () => {
    const srv = await startMgmtServer();

    servers.push(srv);
    srv.setResponder((_req, res) => {
      res.writeHead(500);
      res.end('vhost already exists with different config');
    });

    await expect(makeBootstrapper(srv.host, srv.port).bootstrapDeployment([]))
      .rejects.toThrow(/management API PUT \/api\/vhosts\/%2Fnexxus failed with 500.*vhost already exists/);
  });
});
