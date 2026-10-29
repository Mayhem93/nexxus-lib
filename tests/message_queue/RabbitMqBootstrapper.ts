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

/** A bootstrapper whose adapter config is as validation leaves it, schema defaults included. */
const makeBootstrapper = (host: string, port: number, over: Record<string, unknown> = {}) =>
  new NexxusRabbitMqBootstrapper(OPTIONS, {
    host,
    managementPort: port,
    user: 'admin',
    password: 'admin-pw',
    deadLetterRetention: 259200,
    deadLetterMaxLength: 100,
    ...over,
  });

describe('NexxusRabbitMqBootstrapper.bootstrapDeployment', () => {
  it('declares vhost, user, permissions, exchanges, per-stage queues and the dead-letter policy, in order', async () => {
    const srv = await startMgmtServer();

    servers.push(srv);

    await makeBootstrapper(srv.host, srv.port).bootstrapDeployment(['writer', 'aggregator']);

    expect(srv.puts.map(p => `${p.method} ${p.url}`)).toEqual([
      'PUT /api/vhosts/%2Fnexxus',
      'PUT /api/users/runtime',
      'PUT /api/permissions/%2Fnexxus/runtime',
      'PUT /api/exchanges/%2Fnexxus/systemMessages',
      'PUT /api/exchanges/%2Fnexxus/deadLetters',
      'PUT /api/queues/%2Fnexxus/writer',
      'PUT /api/queues/%2Fnexxus/writer.dlq',
      'POST /api/bindings/%2Fnexxus/e/deadLetters/q/writer.dlq',
      'PUT /api/queues/%2Fnexxus/aggregator',
      'PUT /api/queues/%2Fnexxus/aggregator.dlq',
      'POST /api/bindings/%2Fnexxus/e/deadLetters/q/aggregator.dlq',
      'PUT /api/policies/%2Fnexxus/nexxus-dead-letter',
      'PUT /api/policies/%2Fnexxus/nexxus-dead-letter-retention',
    ]);
  });

  it('dead-letters each stage into a queue of its own, through a policy', async () => {
    const srv = await startMgmtServer();

    servers.push(srv);

    await makeBootstrapper(srv.host, srv.port).bootstrapDeployment(['writer', 'transport-manager', 'websockets-transport']);

    const byCall = Object.fromEntries(srv.puts.map(p => [`${p.method} ${p.url}`, p.body]));

    expect(byCall['PUT /api/exchanges/%2Fnexxus/deadLetters']).toEqual({ type: 'direct', durable: true });
    expect(byCall['PUT /api/queues/%2Fnexxus/writer.dlq']).toEqual({ durable: true, arguments: { 'x-queue-type': 'quorum' } });
    // A dead-lettered message keeps its routing key: the name of the queue it came from.
    expect(byCall['POST /api/bindings/%2Fnexxus/e/deadLetters/q/writer.dlq']).toEqual({ routing_key: 'writer' });
    // Only the stage queues — never the dead-letter queues, nor the per-slot ones.
    expect(byCall['PUT /api/policies/%2Fnexxus/nexxus-dead-letter']).toEqual({
      pattern: '^(writer|transport-manager)$',
      definition: { 'dead-letter-exchange': 'deadLetters' },
      'apply-to': 'queues',
    });
    // The dead-letter queues get a policy of their own, bounding how long and how many.
    expect(byCall['PUT /api/policies/%2Fnexxus/nexxus-dead-letter-retention']).toEqual({
      pattern: '^(writer\\.dlq|transport-manager\\.dlq)$',
      definition: { 'message-ttl': 259200000, 'max-length': 100 },
      'apply-to': 'queues',
    });
  });

  it('bounds the dead-letter queues by the configured retention and length', async () => {
    const srv = await startMgmtServer();

    servers.push(srv);

    await makeBootstrapper(srv.host, srv.port, { deadLetterRetention: 864000, deadLetterMaxLength: 250 })
      .bootstrapDeployment(['writer']);

    const retention = srv.puts.find(p => p.url === '/api/policies/%2Fnexxus/nexxus-dead-letter-retention');

    // RabbitMQ takes the TTL in milliseconds; 864000 seconds is 10 days.
    expect(retention?.body).toMatchObject({ definition: { 'message-ttl': 864000000, 'max-length': 250 } });
  });

  it('declares no policy when no stage has a queue of its own', async () => {
    const srv = await startMgmtServer();

    servers.push(srv);

    await makeBootstrapper(srv.host, srv.port).bootstrapDeployment(['websockets-transport']);

    expect(srv.puts.some(p => p.url?.startsWith('/api/policies/'))).toBe(false);
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

    // No dynamic-stage queues, and no dead-letter queues for them either.
    expect(queueUrls).toEqual(['/api/queues/%2Fnexxus/writer', '/api/queues/%2Fnexxus/writer.dlq']);
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
