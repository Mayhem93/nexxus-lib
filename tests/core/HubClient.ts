import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NexxusHubClient, type NexxusHubNode } from '@mayhem93/nexxus-core-lib';

import * as http from 'node:http';
import * as os from 'node:os';

const TOKEN = 'hub-secret';

const NODE: NexxusHubNode = {
  id: 'node-1',
  role: 'api',
  privateIpAddress: '10.0.0.5',
  managementPort: 9100,
  dependencies: {},
  stats: { uptime: 1 },
};

type RecordedRequest = { method?: string; url?: string; token?: string; body?: string };
type Responder = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

/** A real HTTP server standing in for Hub. Records requests; default routes echo. */
async function makeHub(): Promise<{
  url: string;
  received: RecordedRequest[];
  setResponder: (r: Responder | null) => void;
  close: () => void;
}> {
  const received: RecordedRequest[] = [];
  let responder: Responder | null = null;

  const server = http.createServer((req, res) => {
    let body = '';

    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, token: req.headers['nxx-hub-token'] as string, body: body || undefined });

      if (responder) {
        responder(req, res, body);

        return;
      }

      if (req.headers['nxx-hub-token'] !== TOKEN) {
        res.writeHead(401);
        res.end('bad token');

        return;
      }

      if (req.method === 'POST' && req.url === '/node') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.method === 'GET' && req.url?.startsWith('/node')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 'n1', role: 'api' }]));
      } else if (req.method === 'DELETE' && req.url?.startsWith('/node/')) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, resolve));

  const { port } = server.address() as import('node:net').AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    setResponder: r => { responder = r; },
    close: () => server.close(),
  };
}

const clients: NexxusHubClient[] = [];
const hubs: Array<{ close: () => void }> = [];

afterEach(() => {
  clients.forEach(c => c.dispose());
  clients.length = 0;
  hubs.forEach(h => h.close());
  hubs.length = 0;
  vi.useRealTimers();
});

type CaptureLogger = { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

/** Build a client and track it for disposal. Optionally supply a capturing logger. */
function makeClient(url: string, token = TOKEN, logger?: CaptureLogger): NexxusHubClient {
  const lg = logger ?? { warn: () => {}, info: () => {}, error: () => {} };
  const client = new NexxusHubClient({ endpoint: url, token }, lg as never);

  clients.push(client);

  return client;
}

/** Poll `cond` on real timers until true or timeout. */
function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('waitUntil timed out'));
      } else {
        setTimeout(check, 5);
      }
    };

    check();
  });
}

describe('NexxusHubClient — registerNode / listNodesByRole / unregisterNode', () => {
  it('registers a node: POSTs the payload with the token header and returns it', async () => {
    const hub = await makeHub();

    hubs.push(hub);

    const client = makeClient(hub.url);
    const result = await client.registerNode(async () => NODE);

    expect(result).toEqual(NODE);

    const post = hub.received.find(r => r.method === 'POST');

    expect(post?.token).toBe(TOKEN);
    expect(JSON.parse(post!.body!)).toEqual(NODE);
  });

  it('lists nodes by role, url-encoding the role query', async () => {
    const hub = await makeHub();

    hubs.push(hub);

    const client = makeClient(hub.url);
    const nodes = await client.listNodesByRole('websockets transport');

    expect(nodes).toEqual([{ id: 'n1', role: 'api' }]);
    expect(hub.received.find(r => r.method === 'GET')?.url).toBe('/node?role=websockets%20transport');
  });

  it('unregisters a node: DELETE with the id url-encoded, tolerating an empty (204) body', async () => {
    const hub = await makeHub();

    hubs.push(hub);

    await makeClient(hub.url).unregisterNode('id/with space');

    expect(hub.received.find(r => r.method === 'DELETE')?.url).toBe(`/node/${encodeURIComponent('id/with space')}`);
  });

  it('trims trailing slashes off the endpoint', async () => {
    const hub = await makeHub();

    hubs.push(hub);

    await makeClient(`${hub.url}///`).unregisterNode('x');

    expect(hub.received.find(r => r.method === 'DELETE')?.url).toBe('/node/x');
  });
});

describe('NexxusHubClient — doJson error handling', () => {
  it('throws with status + detail on a non-2xx response', async () => {
    const hub = await makeHub();

    hubs.push(hub);
    hub.setResponder((_req, res) => { res.writeHead(500); res.end('kaboom'); });

    await expect(makeClient(hub.url).unregisterNode('x'))
      .rejects.toThrow(/DELETE \/node\/x failed: 500.*kaboom/);
  });

  it('maps a wrong token to a 401 error', async () => {
    const hub = await makeHub();

    hubs.push(hub);

    await expect(makeClient(hub.url, 'wrong').unregisterNode('x')).rejects.toThrow(/401/);
  });

  it('treats a non-JSON 2xx response as an empty result', async () => {
    const hub = await makeHub();

    hubs.push(hub);
    hub.setResponder((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json');
    });

    expect(await makeClient(hub.url).listNodesByRole('api')).toBeUndefined();
  });
});

describe('NexxusHubClient — dispose', () => {
  it('rejects an in-progress retry loop once disposed', async () => {
    const client = makeClient('http://127.0.0.1:1'); // unreachable — would otherwise retry forever

    client.dispose();

    await expect(client.registerNode(async () => NODE)).rejects.toThrow(/disposed while registerNode was retrying/);
  });
});

describe('NexxusHubClient — retry + re-register loops (shortened intervals)', () => {
  // These statics are `private static readonly` (erased at runtime), so we can
  // shrink the retry/re-register cadence to a few ms and drive the real loops
  // with real timers + a real server instead of fighting fake timers.
  const cls = NexxusHubClient as unknown as { RETRY_INTERVAL_MS: number; REREGISTER_INTERVAL_MS: number };
  const original = { retry: cls.RETRY_INTERVAL_MS, rereg: cls.REREGISTER_INTERVAL_MS };

  beforeEach(() => {
    cls.RETRY_INTERVAL_MS = 10;
    cls.REREGISTER_INTERVAL_MS = 10;
  });

  afterEach(() => {
    cls.RETRY_INTERVAL_MS = original.retry;
    cls.REREGISTER_INTERVAL_MS = original.rereg;
  });

  it('retries registerNode until Hub accepts, warning on each failure', async () => {
    const hub = await makeHub();

    hubs.push(hub);

    let attempts = 0;

    hub.setResponder((_req, res) => {
      attempts += 1;

      if (attempts === 1) {
        res.writeHead(500);
        res.end('hub down');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    const warns: unknown[][] = [];
    const client = makeClient(hub.url, TOKEN, { warn: (...a) => warns.push(a), info: () => {}, error: () => {} });

    const result = await client.registerNode(async () => NODE);

    expect(result).toEqual(NODE);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(String(warns[0]?.[0])).toMatch(/registerNode failed, retrying/);

    client.dispose();
  });

  it('re-registers on the interval and logs recovery after a failed tick', async () => {
    const hub = await makeHub();

    hubs.push(hub);

    let failTicks = false;

    hub.setResponder((_req, res) => {
      if (failTicks) {
        res.writeHead(500);
        res.end('tick down');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    const warns: unknown[][] = [];
    const infos: unknown[][] = [];
    const client = makeClient(hub.url, TOKEN, {
      warn: (...a) => warns.push(a),
      info: (...a) => infos.push(a),
      error: () => {},
    });

    await client.registerNode(async () => NODE); // initial success starts the loop

    failTicks = true;
    await waitUntil(() => warns.some(a => /re-register failed/.test(String(a[0]))));

    failTicks = false;
    await waitUntil(() => infos.some(a => /re-register recovered/.test(String(a[0]))));

    client.dispose();
  });

  it('skips overlapping ticks and bails out of an in-flight tick after dispose()', async () => {
    const hub = await makeHub();

    hubs.push(hub);

    let builds = 0;
    const slowBuild = async (): Promise<NexxusHubNode> => {
      builds += 1;
      await new Promise(resolve => setTimeout(resolve, 60)); // outlasts the 10ms interval

      return NODE;
    };

    const client = makeClient(hub.url);

    await client.registerNode(slowBuild); // initial build (~60ms) then loop starts

    const buildsAfterInit = builds;

    await new Promise(resolve => setTimeout(resolve, 120)); // ~12 intervals, but builds take 60ms each
    client.dispose(); // likely lands while a build is in flight → hits the post-build disposed guard

    // Overlap protection means far fewer builds than intervals elapsed.
    expect(builds - buildsAfterInit).toBeLessThan(6);
  });

  it('stops re-registering after dispose()', async () => {
    const hub = await makeHub();

    hubs.push(hub);

    const client = makeClient(hub.url);

    await client.registerNode(async () => NODE);
    await waitUntil(() => hub.received.filter(r => r.method === 'POST').length >= 2); // at least one tick ran

    client.dispose();

    const afterDispose = hub.received.filter(r => r.method === 'POST').length;

    await new Promise(resolve => setTimeout(resolve, 40)); // several intervals

    expect(hub.received.filter(r => r.method === 'POST').length).toBe(afterDispose);
  });
});

describe('NexxusHubClient — static helpers', () => {
  it('readNexxusDependencies reads installed @mayhem93 package versions', () => {
    const deps = NexxusHubClient.readNexxusDependencies();

    // core-lib is always installed in this workspace.
    expect(typeof deps['@mayhem93/nexxus-core-lib']).toBe('string');
  });

  it('discoverPrivateIpAddress returns a non-internal IPv4, or throws if the host has none', () => {
    // node:os is a frozen ESM namespace (can't spy networkInterfaces), so we
    // assert against the real host: whichever branch this machine exercises.
    const hasExternal = Object.values(os.networkInterfaces())
      .flat()
      .some(n => n && n.family === 'IPv4' && !n.internal);

    if (hasExternal) {
      expect(NexxusHubClient.discoverPrivateIpAddress()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    } else {
      expect(() => NexxusHubClient.discoverPrivateIpAddress()).toThrow(/no non-internal IPv4/);
    }
  });
});
