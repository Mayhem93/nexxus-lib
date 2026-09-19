import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusToken, NexxusUser, authDetailKey, type INexxusUser, type NexxusApplication } from '@mayhem93/nexxus-core-lib';

import UserRoute from '../../src/api/src/lib/routes/User';
import NexxusLocalAuthStrategy from '../../src/api/src/lib/auth/LocalAuthStrategy';

import {
  installApiStatics, seedApp, makeApp, makeAuthApp, seedAuthStrategy, dbState,
  startTestServer, type TestServer,
} from './harness';
import { installFakeRedis } from '../redis/helpers';

const USER = {
  id: 'u1', username: 'ann', userType: 'default',
  authProviders: [ 'local' ], details: {}, appId: 'app1',
} as never;

let server: TestServer;
let app: NexxusApplication;

const APP_ONLY = { 'nxx-app-id': 'app1' };

function as(user: unknown = USER, deviceId = 'd1'): Record<string, string> {
  return {
    'nxx-app-id': 'app1',
    authorization: `Bearer ${NexxusToken.issue(app, { appId: 'app1', deviceId, user: user as never })}`,
  };
}

const send = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
  server.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const storedUser = (overrides: Partial<INexxusUser> = {}): NexxusUser => new NexxusUser({
  id: 'u1', type: 'user', appId: 'app1', username: 'ann', password: null,
  authProviders: [ 'local' ], devices: [], details: {}, userType: 'default', ...overrides,
} as INexxusUser);

/**
 * Stand the route up with a REAL local strategy registered the way
 * `setupAppAuthStrategies` would — `/user/register` reaches for it through
 * `NexxusApi.instance`, so a stub would test the stub.
 */
async function serve(application: NexxusApplication, withLocalStrategy = true): Promise<void> {
  app = seedApp(application);

  if (withLocalStrategy) {
    seedAuthStrategy('app1', 'local', new NexxusLocalAuthStrategy({}, app));
  }

  server = await startTestServer(expressApp => { new UserRoute(expressApp); });
}

describe('POST /user/register', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
    dbState.searchResult = [];
  });

  afterEach(async () => { await server.close(); });

  it('creates the account and returns a usable session', async () => {
    await serve(makeAuthApp());

    const res = await send('POST', '/user/register', { username: 'ann', password: 'hunter2' }, APP_ONLY);

    expect(res.status).toBe(200);
    // Finishes like a login rather than making the client turn straight around
    // and authenticate.
    expect(NexxusToken.verify(app, res.body.token).user).toMatchObject({ username: 'ann' });
    expect(res.body.device.id).toEqual(expect.any(String));
  });

  it('stores the password hashed', async () => {
    await serve(makeAuthApp());

    await send('POST', '/user/register', { username: 'ann', password: 'hunter2' }, APP_ONLY);

    const stored = (dbState.created[0]![0] as NexxusUser).getData().password!;

    expect(stored).not.toBe('hunter2');
    expect(stored).toMatch(/^\$2[aby]\$/);
  });

  /**
   * `userType` and `device` are request parameters, not profile fields. Left in
   * the rest-spread they rode into `details` and were persisted — a device
   * registration hint stored as if it were part of someone's profile, and
   * handed back by `/user/me`.
   */
  it('keeps request parameters out of the stored profile', async () => {
    await serve(makeAuthApp({
      auth: { strategies: { local: {} }, userDetailSchema: { default: { age: { type: 'int', required: false } } } },
    }));

    await send('POST', '/user/register', {
      username: 'ann', password: 'hunter2', userType: 'default', device: { id: 'd1' }, age: 30,
    }, APP_ONLY);

    expect((dbState.created[0]![0] as NexxusUser).getData().details).toEqual({ age: 30 });
  });

  it('rejects a profile field the application never declared', async () => {
    await serve(makeAuthApp());

    const res = await send('POST', '/user/register', {
      username: 'ann', password: 'hunter2', favouriteColour: 'blue',
    }, APP_ONLY);

    // The schema is closed, so registration can't pollute the user index.
    expect(res.status).toBe(400);
    expect(dbState.created).toHaveLength(0);
  });

  it('refuses a caller-supplied auth namespace', async () => {
    await serve(makeAuthApp());

    const res = await send('POST', '/user/register', {
      username: 'ann', password: 'hunter2', [authDetailKey('google')]: { id: 'victims-google-id' },
    }, APP_ONLY);

    // Otherwise registration mints an account pre-linked to someone else's
    // provider identity.
    expect(res.status).toBe(400);
    expect(dbState.created).toHaveLength(0);
  });

  /**
   * A second account registering on a shared machine passes the device id the
   * client still has in local storage. It must NOT be honoured: the device
   * belongs to the first user, it's listed under them, and handing it over
   * would silently move it between accounts.
   */
  it('ignores a device hint naming another user\'s device', async () => {
    await serve(makeAuthApp());

    const ann = await send('POST', '/user/register', { username: 'ann', password: 'p' }, APP_ONLY);

    dbState.searchResult = [];

    const bob = await send('POST', '/user/register',
      { username: 'bob', password: 'p', device: { id: ann.body.device.id } }, APP_ONLY);

    expect(bob.status).toBe(200);
    expect(bob.body.device.id).not.toBe(ann.body.device.id);
  });

  it('names the new device from the hint', async () => {
    await serve(makeAuthApp());

    const res = await send('POST', '/user/register',
      { username: 'ann', password: 'p', device: { name: 'Ann\'s Laptop' } }, APP_ONLY);

    expect(res.body.device.name).toBe('Ann\'s Laptop');
  });

  it('409s a username already taken', async () => {
    await serve(makeAuthApp());
    dbState.searchResult = [ storedUser() ];

    const res = await send('POST', '/user/register', { username: 'ann', password: 'p' }, APP_ONLY);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('UserAlreadyExistsException');
  });

  it('requires a username and a password', async () => {
    await serve(makeAuthApp());

    for (const body of [ {}, { username: 'ann' }, { password: 'p' }, { username: 42, password: 'p' } ]) {
      const res = await send('POST', '/user/register', body, APP_ONLY);

      expect(res.status).toBe(400);
    }
  });

  it('rejects a user type the application does not declare', async () => {
    await serve(makeAuthApp());

    const res = await send('POST', '/user/register',
      { username: 'ann', password: 'p', userType: 'admin' }, APP_ONLY);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid user type "admin"/);
  });

  it('refuses on an application with no authentication', async () => {
    await serve(makeApp(), false);

    const res = await send('POST', '/user/register', { username: 'ann', password: 'p' }, APP_ONLY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidAuthMethodException');
  });

  it('refuses when the application has auth but no local strategy', async () => {
    await serve(makeAuthApp({ auth: { strategies: { google: {} }, userDetailSchema: { default: {} } } }), false);

    const res = await send('POST', '/user/register', { username: 'ann', password: 'p' }, APP_ONLY);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Local authentication is not available/);
  });

  it('404s an unknown application', async () => {
    await serve(makeAuthApp());

    expect((await send('POST', '/user/register', { username: 'a', password: 'p' }, { 'nxx-app-id': 'ghost' })).status)
      .toBe(404);
  });

  it('needs no token — it is one of the endpoints that mints one', async () => {
    await serve(makeAuthApp());

    expect((await send('POST', '/user/register', { username: 'ann', password: 'p' }, APP_ONLY)).status).toBe(200);
  });
});

describe('GET /user/me', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('returns the principal the token carries', async () => {
    await serve(makeAuthApp());

    const res = await server.request('/user/me', { headers: as() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(USER);
  });

  it('answers from the token without reading the database', async () => {
    await serve(makeAuthApp());

    await server.request('/user/me', { headers: as() });

    expect(dbState.getItemsCalls).toHaveLength(0);
    expect(dbState.searchCalls).toHaveLength(0);
  });

  it('never exposes a password', async () => {
    await serve(makeAuthApp());

    const res = await server.request('/user/me', { headers: as() });

    expect(res.body).not.toHaveProperty('password');
  });

  it('401s without a token', async () => {
    await serve(makeAuthApp());

    expect((await server.request('/user/me', { headers: APP_ONLY })).status).toBe(401);
  });

  it('400s a device-only token on an application without authentication', async () => {
    await serve(makeApp(), false);

    const res = await server.request('/user/me', { headers: APP_ONLY });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidAuthMethodException');
  });
});

describe('PUT /user', () => {
  const patch = (body: unknown, headers = as()) => send('PUT', '/user', body, headers);

  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('applies a patch to the caller\'s own record', async () => {
    await serve(makeAuthApp({
      auth: { strategies: { local: {} }, userDetailSchema: { default: { age: { type: 'int', required: false } } } },
    }));

    const res = await patch({ patch: { op: 'replace', path: [ 'details.age' ], value: [ 31 ] } });

    expect(res.status).toBe(200);

    const patches = dbState.updateCalls[0]!.patches;

    expect(patches[0].get()).toMatchObject({ path: [ 'details.age' ], metadata: { id: 'u1', appId: 'app1' } });
    // Always stamped, so a client can't update without moving updatedAt.
    expect(patches[1].get().path).toEqual([ 'updatedAt' ]);
  });

  it('rejects a patch with no path or value arrays', async () => {
    await serve(makeAuthApp());

    // `{"patch":{}}` used to reach `patch.path.filter` and surface as a 500.
    for (const body of [ {}, { patch: {} }, { patch: { path: 'details.age' } }, { patch: { path: [], value: 'x' } } ]) {
      const res = await patch(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidParametersException');
    }
  });

  it.each([ 'userType', 'authProviders', 'devices', 'createdAt', 'updatedAt' ])(
    'refuses to patch %s', async (path) => {
      await serve(makeAuthApp());

      const res = await patch({ patch: { op: 'replace', path: [ path ], value: [ 'x' ] } });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/cannot be updated/);
    });

  /**
   * `$auth_*` subtrees are written by auth strategies at login. A client able
   * to edit `details.$auth_google.id` could repoint its account at another
   * person's provider identity.
   */
  it('refuses to patch an auth-owned detail namespace', async () => {
    await serve(makeAuthApp());

    for (const path of [ 'details.$auth_google', 'details.$auth_google.id', 'details.$anything' ]) {
      const res = await patch({ patch: { op: 'replace', path: [ path ], value: [ { id: 'victim' } ] } });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/cannot be updated/);
    }
  });

  it('names every forbidden path it found, not just the first', async () => {
    await serve(makeAuthApp());

    const res = await patch({
      patch: { op: 'replace', path: [ 'userType', 'devices' ], value: [ 'admin', [] ] },
    });

    expect(res.body.message).toMatch(/userType, devices/);
  });

  it('hashes a password before it reaches the patch', async () => {
    await serve(makeAuthApp());

    await patch({ patch: { op: 'replace', path: [ 'password' ], value: [ 'hunter2' ] } });

    const value = dbState.updateCalls[0]!.patches[0].get().value[0];

    expect(value).not.toBe('hunter2');
    expect(value).toMatch(/^\$2[aby]\$/);
  });

  it('adds the local provider when an OAuth-only account sets a password', async () => {
    await serve(makeAuthApp());

    // Setting a password is what makes local login possible, so the account has
    // to start claiming it.
    const oauthOnly = { ...USER as object, authProviders: [ 'google' ] };

    await patch({ patch: { op: 'replace', path: [ 'password' ], value: [ 'hunter2' ] } }, as(oauthOnly));

    const paths = dbState.updateCalls[0]!.patches.map((p: any) => p.get().path[0]);

    expect(paths).toContain('authProviders');
  });

  it('does not re-add the local provider when the account already has it', async () => {
    await serve(makeAuthApp());

    await patch({ patch: { op: 'replace', path: [ 'password' ], value: [ 'hunter2' ] } });

    const paths = dbState.updateCalls[0]!.patches.map((p: any) => p.get().path[0]);

    expect(paths).not.toContain('authProviders');
  });

  it('500s when the token names a user type the application no longer declares', async () => {
    await serve(makeAuthApp());

    // Tokens outlive config edits: a 7-day token minted for a user type that
    // has since been removed is a server-side inconsistency, not bad input.
    const res = await patch(
      { patch: { op: 'replace', path: [ 'details.age' ], value: [ 31 ] } },
      as({ ...USER as object, userType: 'removed-since' }),
    );

    expect(res.status).toBe(500);
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('rejects a patch the user schema does not allow', async () => {
    await serve(makeAuthApp());

    const res = await patch({ patch: { op: 'replace', path: [ 'details.ghost' ], value: [ 'x' ] } });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid JSON Patch/);
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('401s without a token and 400s without a principal', async () => {
    await serve(makeAuthApp());

    expect((await patch({ patch: { op: 'replace', path: [ 'x' ], value: [ 1 ] } }, APP_ONLY)).status).toBe(401);

    await server.close();
    await serve(makeApp(), false);

    expect((await patch({ patch: { op: 'replace', path: [ 'x' ], value: [ 1 ] } }, APP_ONLY)).status).toBe(400);
  });
});

