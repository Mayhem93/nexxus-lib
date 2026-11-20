import { describe, it, expect, afterEach } from 'vitest';

import { NexxusApiCors } from '../../src/api/src/lib/Cors';
import { TooManyRequestsException, UserAuthenticationFailedException } from '../../src/api/src/lib/Exceptions';

import { startTestServer, type TestServer, type TestResponse } from './harness';

import type { RequestHandler } from 'express';

let server: TestServer;

const LISTED = 'https://demo.example.com';

/**
 * The middleware, first as the API puts it, in front of a route that answers
 * `200` and two that fail the way real routes do.
 */
async function serve(origins: string[]): Promise<void> {
  server = await startTestServer(expressApp => {
    expressApp.use(NexxusApiCors.middleware(origins));
    expressApp.get('/ok', ((_req, res) => { res.status(200).json({ ok: true }); }) as RequestHandler);
    expressApp.get('/unauthorized', (() => { throw new UserAuthenticationFailedException('Invalid token'); }) as RequestHandler);
    expressApp.get('/limited', ((_req, res) => {
      res.setHeader('Retry-After', '30');
      throw new TooManyRequestsException('Too many requests; try again in 30 seconds');
    }) as RequestHandler);
  });
}

/** The preflight a browser sends before a `POST` with the headers every Nexxus request carries. */
const preflight = (origin: string, path = '/model'): Promise<TestResponse> => server.request(path, {
  method: 'OPTIONS',
  headers: {
    origin,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization, content-type, nxx-app-id',
  },
});

const get = (path: string, origin?: string): Promise<TestResponse> =>
  server.request(path, { headers: origin === undefined ? {} : { origin } });

describe('NexxusApiCors', () => {
  afterEach(async () => { await server.close(); });

  it('adds nothing to a request without an Origin', async () => {
    await serve([ LISTED ]);

    const res = await get('/ok');

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a listed origin\'s preflight with 204 and what the page may send', async () => {
    await serve([ LISTED ]);

    const res = await preflight(LISTED);

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(LISTED);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE');
    expect(res.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type, nxx-app-id, nxx-connection-id');
    expect(res.headers.get('access-control-max-age')).toBe('7200');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('refuses any other origin\'s preflight with 403, naming the origin, and no CORS headers', async () => {
    await serve([ LISTED ]);

    const res = await preflight('https://elsewhere.example.com');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'OriginNotAllowedException',
      message: 'Origin "https://elsewhere.example.com" is not in the API\'s cors.origins',
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses every preflight with the default, empty list', async () => {
    await serve([]);

    expect((await preflight(LISTED)).status).toBe(403);
  });

  it('answers any origin with "*"', async () => {
    await serve([ '*' ]);

    const pre = await preflight('http://localhost:5173');

    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('vary')).toBeNull();
    expect((await get('/ok', 'https://anywhere.example.com')).headers.get('access-control-allow-origin')).toBe('*');
  });

  it('matches an origin exactly: scheme, host and port', async () => {
    await serve([ 'http://localhost:5173' ]);

    expect((await preflight('http://localhost:5173')).status).toBe(204);
    expect((await preflight('http://localhost:3000')).status).toBe(403);
    expect((await preflight('http://127.0.0.1:5173')).status).toBe(403);
    expect((await preflight('https://localhost:5173')).status).toBe(403);
  });

  it('matches a listed origin written in capitals or with its default port', async () => {
    await serve([ 'https://Demo.Example.com:443' ]);

    expect((await preflight(LISTED)).status).toBe(204);
  });

  it('lets a listed origin read the response, and the headers it needs', async () => {
    await serve([ LISTED ]);

    const res = await get('/ok', LISTED);

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(LISTED);
    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After, RateLimit, RateLimit-Policy');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('serves any other origin without CORS headers', async () => {
    await serve([ LISTED ]);

    const res = await get('/ok', 'https://elsewhere.example.com');

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps the headers on error responses, so a page can read their status', async () => {
    await serve([ LISTED ]);

    const unauthorized = await get('/unauthorized', LISTED);
    const limited = await get('/limited', LISTED);

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('access-control-allow-origin')).toBe(LISTED);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('access-control-allow-origin')).toBe(LISTED);
    expect(limited.headers.get('retry-after')).toBe('30');
  });

  it('treats an OPTIONS without Access-Control-Request-Method as an ordinary request', async () => {
    await serve([ LISTED ]);

    const res = await server.request('/ok', { method: 'OPTIONS', headers: { origin: LISTED } });

    expect(res.status).not.toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
  });
});
