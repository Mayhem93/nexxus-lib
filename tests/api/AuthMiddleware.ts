import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusToken, type NexxusTokenUser } from '@mayhem93/nexxus-core-lib';

import AuthMiddleware from '../../src/api/src/lib/middlewares/Auth';
import type { NexxusApiRequest } from '../../src/api/src/lib/Api';

import {
  installApiStatics,
  seedApp,
  makeApp,
  makeAuthApp,
  startTestServer,
  type TestServer,
} from './harness';

import type { RequestHandler } from 'express';

const USER = {
  id: 'u1', username: 'ann', userType: 'default',
  authProviders: [ 'local' ], details: {}, appId: 'app1',
} as NexxusTokenUser;

/** Reports exactly what the middleware established on the request. */
const reached: RequestHandler = (req, res) => {
  const r = req as NexxusApiRequest;

  res.status(200).json({ user: r.user ?? null, deviceId: r.deviceId ?? null });
};

const bearer = (token: string): RequestInit => ({ headers: { 'nxx-app-id': 'app1', authorization: `Bearer ${token}` } });
const forApp = (appId: string): RequestInit => ({ headers: { 'nxx-app-id': appId } });

async function serve(): Promise<TestServer> {
  return startTestServer(app => {
    app.use(AuthMiddleware as RequestHandler);
    app.get('/', reached);
  });
}

describe('AuthMiddleware — no token presented', () => {
  let server: TestServer;

  beforeEach(async () => {
    installApiStatics();
    server = await serve();
  });

  afterEach(async () => { await server.close(); });

  it('lets a tokenless request through on an application without authentication', async () => {
    // The endpoints that MINT a token can't require one, so absence is allowed
    // and the route decides whether it needs a principal.
    seedApp(makeApp());

    const res = await server.request('/', forApp('app1'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null, deviceId: null });
  });

  it('rejects a tokenless request on an application WITH authentication', async () => {
    seedApp(makeAuthApp());

    const res = await server.request('/', forApp('app1'));

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'NoAuthPresentException', message: 'No token provided' });
  });

  it('lets a tokenless request for an UNKNOWN application through', async () => {
    // Nothing to verify and no app to ask about auth, so this middleware has no
    // opinion — AppExistsMiddleware is what rejects an unknown app, and every
    // router that mounts this one mounts that one first.
    const res = await server.request('/', forApp('ghost'));

    expect(res.status).toBe(200);
  });

  it('treats a bare "Bearer" header as no token at all', async () => {
    seedApp(makeAuthApp());

    // HTTP drops the trailing space, so the server sees exactly `Bearer` — it
    // must strip to empty rather than become the literal token "Bearer", which
    // would report "Invalid token" for a request that simply carried none.
    const res = await server.request('/', {
      headers: { 'nxx-app-id': 'app1', authorization: 'Bearer ' },
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NoAuthPresentException');
  });
});

describe('AuthMiddleware — Authorization header parsing', () => {
  let server: TestServer;
  let token: string;

  beforeEach(async () => {
    installApiStatics();

    const app = seedApp(makeAuthApp());

    token = NexxusToken.issue(app, { appId: 'app1', deviceId: 'd1', user: USER });
    server = await serve();
  });

  afterEach(async () => { await server.close(); });

  /**
   * RFC 7235 makes the auth scheme case-INsensitive, so every one of these is a
   * legitimate thing for a client to send. They were not all accepted before:
   * the scheme was stripped with a literal `'Bearer '`, so a lowercase one
   * survived and the entire header got verified as if it were the credential.
   */
  it.each([ 'Bearer', 'bearer', 'BEARER', 'BeArEr' ])('accepts the "%s" scheme spelling', async (scheme) => {
    const res = await server.request('/', {
      headers: { 'nxx-app-id': 'app1', authorization: `${scheme} ${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe('d1');
  });

  it('tolerates extra whitespace after the scheme', async () => {
    const res = await server.request('/', {
      headers: { 'nxx-app-id': 'app1', authorization: `Bearer    ${token}` },
    });

    expect(res.status).toBe(200);
  });

  it('only strips a LEADING scheme', async () => {
    // Anchored, so nothing matching mid-string can be cut out of a credential.
    // JWTs are base64url and can't contain a space, but the parser shouldn't be
    // relying on that to stay correct.
    const res = await server.request('/', {
      headers: { 'nxx-app-id': 'app1', authorization: `Bearer Bearer ${token}` },
    });

    expect(res.status).toBe(401);
  });
});

describe('AuthMiddleware — valid token', () => {
  let server: TestServer;

  beforeEach(async () => {
    installApiStatics();
    server = await serve();
  });

  afterEach(async () => { await server.close(); });

  it('populates both the principal and the device from a user token', async () => {
    const app = seedApp(makeAuthApp());
    const token = NexxusToken.issue(app, { appId: 'app1', deviceId: 'd1', user: USER });

    const res = await server.request('/', bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe('d1');
    expect(res.body.user).toMatchObject({ id: 'u1', username: 'ann' });
  });

  it('populates only the device from a device-only token', async () => {
    // The zero-auth flavour: same verification path, one fewer claim. There is
    // no separate mechanism per application flavour.
    const app = seedApp(makeApp());
    const token = NexxusToken.issue(app, { appId: 'app1', deviceId: 'd1' });

    const res = await server.request('/', bearer(token));

    expect(res.body).toEqual({ user: null, deviceId: 'd1' });
  });

  it('accepts a token sent without the "Bearer " scheme', async () => {
    const app = seedApp(makeAuthApp());
    const token = NexxusToken.issue(app, { appId: 'app1', deviceId: 'd1', user: USER });

    const res = await server.request('/', {
      headers: { 'nxx-app-id': 'app1', authorization: token },
    });

    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe('d1');
  });

  it('carries the user claim through verbatim', async () => {
    // `/user/me` hands `req.user` straight back to the client, so whatever the
    // middleware puts here IS the response body of that endpoint.
    const app = seedApp(makeAuthApp());
    const token = NexxusToken.issue(app, { appId: 'app1', deviceId: 'd1', user: USER });

    const res = await server.request('/', bearer(token));

    expect(res.body.user).toEqual(USER);
  });
});

describe('AuthMiddleware — rejected tokens', () => {
  let server: TestServer;

  beforeEach(async () => {
    installApiStatics();
    server = await serve();
  });

  afterEach(async () => { await server.close(); });

  it('404s a token presented for an application that is not loaded', async () => {
    // Unlike the tokenless case, this one can't be waved through: verification
    // needs the application's signing key, so an unresolvable app is fatal here
    // rather than merely uninteresting.
    const other = makeApp({ id: 'other' });
    const token = NexxusToken.issue(other, { appId: 'other', deviceId: 'd1' });

    const res = await server.request('/', {
      headers: { 'nxx-app-id': 'ghost', authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'ApplicationNotFoundException' });
  });

  it('401s a token signed with a different key', async () => {
    seedApp(makeAuthApp());

    const impostor = makeApp({ id: 'app1', signingSecret: 'not-the-real-key' });
    const token = NexxusToken.issue(impostor, { appId: 'app1', deviceId: 'd1', user: USER });

    const res = await server.request('/', bearer(token));

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'UserAuthenticationFailedException', message: 'Invalid token' });
  });

  it('401s a token minted for a different application', async () => {
    seedApp(makeAuthApp());
    seedApp(makeAuthApp({ id: 'app2' }));

    const app2 = makeAuthApp({ id: 'app2' });
    const token = NexxusToken.issue(app2, { appId: 'app2', deviceId: 'd1', user: USER });

    // Presented against app1, whose key and audience both disagree.
    const res = await server.request('/', bearer(token));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UserAuthenticationFailedException');
  });

  it('distinguishes an EXPIRED token from an invalid one', async () => {
    // Expiry is the one failure a client can act on by re-authenticating, so it
    // must not be flattened into a generic "invalid".
    const app = seedApp(makeAuthApp({
      auth: { strategies: { local: {} }, userDetailSchema: { default: {} }, jwtExpiresIn: '1ms' },
    }));
    const token = NexxusToken.issue(app, { appId: 'app1', deviceId: 'd1', user: USER });

    await new Promise(resolve => setTimeout(resolve, 20));

    const res = await server.request('/', bearer(token));

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'UserTokenExpiredException', message: 'Token has expired' });
  });

  it('401s structurally malformed input without leaking the library error', async () => {
    seedApp(makeAuthApp());

    for (const bad of [ 'not-a-jwt', 'a.b.c', '{}' ]) {
      const res = await server.request('/', bearer(bad));

      expect(res.status).toBe(401);
      // jsonwebtoken's own wording ("jwt malformed", "invalid signature")
      // describes our implementation, not the caller's mistake.
      expect(res.body.message).toBe('Invalid token');
      expect(res.body.error).toBe('UserAuthenticationFailedException');
    }
  });

  it('401s a token whose payload was edited', async () => {
    const app = seedApp(makeAuthApp());
    const token = NexxusToken.issue(app, { appId: 'app1', deviceId: 'd1', user: USER });
    const [ header, payload, signature ] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, deviceId: 'someone-elses' })).toString('base64url');

    const res = await server.request('/', bearer(`${header}.${forged}.${signature}`));

    expect(res.status).toBe(401);
  });

  it('401s a correctly signed token whose device claim is empty', async () => {
    // Core refuses these, and that refusal is what lets every consumer treat
    // `claims.deviceId` as a usable string. An empty one satisfies `typeof ===
    // 'string'` but names nothing: it would verify cleanly, then be rejected
    // downstream by RequiresDevice as "no device" — or, worse, reach Redis.
    const app = seedApp(makeAuthApp());
    const token = NexxusToken.issue(app, { appId: 'app1', deviceId: '' });

    const res = await server.request('/', bearer(token));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UserAuthenticationFailedException');
  });

  it('never reaches the route on a rejected token', async () => {
    seedApp(makeAuthApp());

    const res = await server.request('/', bearer('not-a-jwt'));

    expect(res.body.user).toBeUndefined();
    expect(res.body.deviceId).toBeUndefined();
  });
});
