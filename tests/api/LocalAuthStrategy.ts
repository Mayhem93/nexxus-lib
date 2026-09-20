import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusToken, NexxusUser, type INexxusUser, type NexxusApplication } from '@mayhem93/nexxus-core-lib';

import NexxusLocalAuthStrategy from '../../src/api/src/lib/auth/LocalAuthStrategy';
import NexxusAuthStrategy from '../../src/api/src/lib/auth/AuthStrategy';

import { installApiStatics, seedApp, makeAuthApp, dbState, logger, startTestServer, type TestServer } from './harness';
import { installFakeRedis } from '../redis/helpers';

import passport from 'passport';
import type { RequestHandler } from 'express';

const PASSWORD = 'hunter2';

/** A stored account whose password hash is real bcrypt, so verification is too. */
async function storedUser(overrides: Partial<INexxusUser> = {}): Promise<NexxusUser> {
  return new NexxusUser({
    id: 'u1', type: 'user', appId: 'app1', username: 'ann',
    password: await NexxusAuthStrategy.hashPassword(PASSWORD),
    authProviders: [ 'local' ], devices: [], details: {}, userType: 'default',
    ...overrides,
  } as INexxusUser);
}

describe('NexxusLocalAuthStrategy — declared metadata', () => {
  beforeEach(() => { installApiStatics(); });

  it('needs no callback route', () => {
    // Nothing redirects anywhere, so there is no `/auth/local/callback`.
    expect(NexxusLocalAuthStrategy.requiresCallback).toBe(false);
  });

  it('contributes no detail namespace', () => {
    // A password tells us nothing about the user, so there is no `$auth_local`
    // subtree — an empty contribution rather than an empty object nothing can
    // be stored in.
    expect(NexxusLocalAuthStrategy.userDetailSchema).toEqual({});
  });

  it('accepts its (empty) config and rejects anything in it', () => {
    const app = seedApp(makeAuthApp());

    expect(() => new NexxusLocalAuthStrategy({}, app)).not.toThrow();
    expect(() => new NexxusLocalAuthStrategy({ clientID: 'x' } as never, app)).toThrow(/"clientID"/);
  });
});

describe('NexxusLocalAuthStrategy.verifyCredentials', () => {
  let strategy: NexxusLocalAuthStrategy & {
    verifyCredentials(u: string, p: string, done: (e: unknown, user?: unknown, info?: unknown) => void): Promise<void>;
  };

  /** Run the verify step and resolve with everything it passed to `done`. */
  function verify(username: string, password: string): Promise<{ err: unknown; user: any; info: any }> {
    return new Promise(resolve => {
      void strategy.verifyCredentials(username, password, (err, user, info) => resolve({ err, user, info }));
    });
  }

  beforeEach(() => {
    installApiStatics();
    strategy = new NexxusLocalAuthStrategy({}, seedApp(makeAuthApp())) as never;
  });

  it('accepts the right password', async () => {
    dbState.searchResult = [ await storedUser() ];

    const { err, user } = await verify('ann', PASSWORD);

    expect(err).toBeNull();
    expect(user).toMatchObject({ id: 'u1', username: 'ann' });
  });

  it('never hands back the password hash', async () => {
    dbState.searchResult = [ await storedUser() ];

    expect((await verify('ann', PASSWORD)).user).not.toHaveProperty('password');
  });

  it('rejects the wrong password', async () => {
    dbState.searchResult = [ await storedUser() ];

    const { user, info } = await verify('ann', 'wrong');

    expect(user).toBe(false);
    expect((info as Error).message).toBe('Invalid credentials');
  });

  it('rejects an unknown username', async () => {
    dbState.searchResult = [];

    const { user, info } = await verify('nobody', PASSWORD);

    expect(user).toBe(false);
    expect((info as Error).message).toBe('Invalid credentials');
  });

  /**
   * An account created through an OAuth provider has `password: null`. Local
   * login must not succeed against it — with any password, including an empty
   * one — or a Google-only account could be taken over by guessing nothing.
   */
  it('rejects an account that has no local password at all', async () => {
    dbState.searchResult = [ await storedUser({ password: null, authProviders: [ 'google' ] }) ];

    for (const attempt of [ PASSWORD, '', 'anything' ]) {
      expect((await verify('ann', attempt)).user).toBe(false);
    }
  });

  it('gives the SAME message whether the user or the password is wrong', async () => {
    dbState.searchResult = [ await storedUser() ];
    const wrongPassword = await verify('ann', 'wrong');

    dbState.searchResult = [];
    const wrongUser = await verify('nobody', PASSWORD);

    // Distinguishing them would make the login endpoint an account enumeration
    // oracle: "which of these addresses has an account here?"
    expect((wrongPassword.info as Error).message).toBe((wrongUser.info as Error).message);
  });

  it('reports a lookup failure through done rather than throwing', async () => {
    dbState.searchImpl = () => { throw new Error('elasticsearch is down'); };

    const { err, user } = await verify('ann', PASSWORD);

    expect((err as Error).message).toBe('elasticsearch is down');
    expect(user).toBeUndefined();
  });

  it('searches within its own application', async () => {
    dbState.searchResult = [];

    await verify('ann', PASSWORD);

    expect(dbState.searchCalls[0]).toMatchObject({ appId: 'app1', type: 'user' });
  });
});

/**
 * `handleAuth` IS a route handler — passport-local reads the credentials off a
 * parsed request body — so it's driven through a real request rather than a
 * hand-built `req`.
 */
describe('NexxusLocalAuthStrategy.handleAuth', () => {
  let server: TestServer;
  let strategy: NexxusLocalAuthStrategy;
  let app: NexxusApplication;

  beforeEach(async () => {
    installApiStatics();
    installFakeRedis();
    app = seedApp(makeAuthApp());
    strategy = new NexxusLocalAuthStrategy({}, app);
    strategy.initializePassport();

    server = await startTestServer(expressApp => {
      expressApp.post('/auth/local', strategy.handleAuth.bind(strategy) as RequestHandler);
    });
  });

  afterEach(async () => {
    passport.unuse(strategy.passportName);
    await server.close();
  });

  const login = (body: unknown) => server.request('/auth/local', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'nxx-app-id': 'app1' },
    body: JSON.stringify(body),
  });

  it('returns a token bound to a device on success', async () => {
    dbState.searchResult = [ await storedUser() ];

    const res = await login({ username: 'ann', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(NexxusToken.verify(app, res.body.token).deviceId).toBe(res.body.device.id);
    expect(res.body.user).toEqual({ id: 'u1', username: 'ann' });
  });

  it('reuses the device the client hinted at', async () => {
    dbState.searchResult = [ await storedUser() ];

    const first = await login({ username: 'ann', password: PASSWORD });
    const second = await login({ username: 'ann', password: PASSWORD, device: { id: first.body.device.id } });

    // What stops a returning user accruing a device every time their token
    // expires.
    expect(second.body.device.id).toBe(first.body.device.id);
  });

  it('401s a wrong password', async () => {
    dbState.searchResult = [ await storedUser() ];

    const res = await login({ username: 'ann', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'UserAuthenticationFailedException', message: 'Authentication failed' });
  });

  it('distinguishes MISSING credentials from wrong ones', async () => {
    // Passport reports an absent field as "Missing credentials" — a client
    // error worth telling the caller about, unlike a failed match.
    const res = await login({});

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Username and password are required');
  });

  it('treats a missing password the same as missing credentials', async () => {
    expect((await login({ username: 'ann' })).body.message).toBe('Username and password are required');
  });

  it('does not reveal whether the account exists', async () => {
    dbState.searchResult = [ await storedUser() ];
    const wrongPassword = await login({ username: 'ann', password: 'wrong' });

    dbState.searchResult = [];
    const noSuchUser = await login({ username: 'nobody', password: PASSWORD });

    expect(noSuchUser.status).toBe(wrongPassword.status);
    expect(noSuchUser.body).toEqual(wrongPassword.body);
  });

  it('logs the underlying reason without returning it', async () => {
    dbState.searchResult = [];

    const res = await login({ username: 'nobody', password: PASSWORD });

    expect(logger.has('debug', /Local authentication failed/)).toBe(true);
    expect(res.body.message).toBe('Authentication failed');
  });

  it('forwards an unexpected failure to the error middleware', async () => {
    dbState.searchImpl = () => { throw new Error('elasticsearch is down'); };

    const res = await login({ username: 'ann', password: PASSWORD });

    // A 500 the error middleware sanitizes, not a 401 — the credentials were
    // never actually checked.
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'ServerErrorException' });
  });
});
