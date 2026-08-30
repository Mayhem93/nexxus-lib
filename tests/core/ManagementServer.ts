import { describe, it, expect, afterEach } from 'vitest';
import { NexxusManagementServer } from '@mayhem93/nexxus-core-lib';

import * as net from 'node:net';

const TOKEN = 'secret-token';
const STATS = { uptime: 123, ok: true };
const host = { getStats: async () => STATS };

/** Started servers to tear down after each test. */
const started: NexxusManagementServer[] = [];

afterEach(() => {
  started.forEach(s => s.close());
  started.length = 0;
});

/** Ask the OS for a free port (small race window, fine for tests). */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;

      probe.close(() => resolve(port));
    });
  });
}

/** Construct + start a management server on a free port, tracked for cleanup. */
async function startServer(): Promise<{ server: NexxusManagementServer; port: number }> {
  const port = await getFreePort();
  const server = new NexxusManagementServer(host, { port, token: TOKEN });

  started.push(server);
  await server.start();

  return { server, port };
}

const get = (port: number, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/stats`, { headers });

describe('NexxusManagementServer /stats', () => {
  it('returns the host stats as JSON with a valid bearer token', async () => {
    const { port } = await startServer();

    const res = await get(port, { Authorization: `Bearer ${TOKEN}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATS);
  });

  it('returns 401 when the token is missing', async () => {
    const { port } = await startServer();

    expect((await get(port)).status).toBe(401);
  });

  it('returns 401 when the token is wrong', async () => {
    const { port } = await startServer();

    expect((await get(port, { Authorization: 'Bearer nope' })).status).toBe(401);
  });
});

describe('NexxusManagementServer lifecycle', () => {
  it('throws when start() is called while already running', async () => {
    const { server } = await startServer();

    expect(() => server.start()).toThrow(/already running/);
  });

  it('rejects start() when the port is already in use', async () => {
    const { port } = await startServer();
    const clashing = new NexxusManagementServer(host, { port, token: TOKEN });

    started.push(clashing);
    await expect(clashing.start()).rejects.toThrow();
  });

  it('close() stops the server and is idempotent', async () => {
    const { server, port } = await startServer();

    server.close();
    expect(() => server.close()).not.toThrow(); // second close is a no-op

    // Give the socket a moment to release, then confirm connections are refused.
    await new Promise(resolve => setTimeout(resolve, 50));
    await expect(get(port, { Authorization: `Bearer ${TOKEN}` })).rejects.toThrow();
  });
});
