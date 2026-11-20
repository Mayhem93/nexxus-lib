import { describe, it, expect, afterEach } from 'vitest';

import { NexxusApiClientAddress } from '../../src/api/src/lib/ClientAddress';

import { startTestServer, type TestServer } from './harness';

import type { RequestHandler } from 'express';

let server: TestServer;

/**
 * Serve `GET /ip` behind `trustProxy` proxies, as the API sets Express up,
 * answering with the client address Express resolves and the header as the
 * route sees it.
 */
async function serve(trustProxy: number): Promise<void> {
  server = await startTestServer(expressApp => {
    expressApp.set('trust proxy', trustProxy);
    expressApp.use(NexxusApiClientAddress.stripForwardedPorts as RequestHandler);
    expressApp.get('/ip', ((req, res) => {
      res.json({ ip: req.ip, forwardedFor: req.headers['x-forwarded-for'] ?? null });
    }) as RequestHandler);
  });
}

async function resolve(forwardedFor: string): Promise<{ ip: string; forwardedFor: string | null }> {
  return (await server.request('/ip', { headers: { 'x-forwarded-for': forwardedFor } })).body;
}

describe('NexxusApiClientAddress', () => {
  afterEach(async () => { await server.close(); });

  it('drops the port from an IPv4 entry', async () => {
    await serve(1);

    expect(await resolve('203.0.113.7:4711')).toEqual({ ip: '203.0.113.7', forwardedFor: '203.0.113.7' });
  });

  it('drops the port from a bracketed IPv6 entry', async () => {
    await serve(1);

    expect(await resolve('[2001:db8::7]:4711')).toEqual({ ip: '2001:db8::7', forwardedFor: '2001:db8::7' });
  });

  it('drops the port from every entry, whichever one trustProxy picks', async () => {
    await serve(2);

    expect(await resolve('198.51.100.1:1111, 203.0.113.7:2222'))
      .toEqual({ ip: '198.51.100.1', forwardedFor: '198.51.100.1, 203.0.113.7' });
  });

  it('leaves an entry without a port as it is', async () => {
    await serve(1);

    // An IPv6 address ending in a group of digits is not an address and a port.
    expect((await resolve('2001:db8::1:80')).ip).toBe('2001:db8::1:80');
    expect((await resolve('unknown')).forwardedFor).toBe('unknown');
  });

  it('takes the address from the end the proxies write to, not from what the client sent', async () => {
    await serve(1);

    expect((await resolve('198.51.100.1, 203.0.113.7')).ip).toBe('203.0.113.7');
  });

  it('takes the address of the connection, and not the header, without trusted proxies', async () => {
    await serve(0);

    const { ip } = await resolve('203.0.113.7');

    expect(ip).not.toBe('203.0.113.7');
    expect(ip).toMatch(/127\.0\.0\.1$/);
  });
});
