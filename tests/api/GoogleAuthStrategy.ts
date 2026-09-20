import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusUser, authDetailKey, type INexxusUser, type NexxusApplication } from '@mayhem93/nexxus-core-lib';
import { NexxusAuthNonce } from '@mayhem93/nexxus-redis';

import NexxusGoogleAuthStrategy from '../../src/api/src/lib/auth/GoogleAuthStrategy';
import NexxusAuthStrategy from '../../src/api/src/lib/auth/AuthStrategy';
import type { NexxusApiRequest, NexxusApiResponse } from '../../src/api/src/lib/Api';

import { installApiStatics, seedApp, makeAuthApp, dbState } from './harness';
import { installFakeRedis } from '../redis/helpers';

import passport from 'passport';
import { Strategy as PassportStrategy } from 'passport-strategy';
import type { Request, Response } from 'express';

const CONFIG = {
  clientID: 'client-id',
  clientSecret: 'client-secret',
  callbackURL: 'http://localhost:3000/auth/google/callback',
};

/**
 * Stands in for the real Google strategy — the ONLY thing mocked here, and for
 * the usual reason: it is a client for a third-party service, so exercising it
 * would mean an outbound OAuth round trip. Everything around it (state signing,
 * nonce redemption, account linking) is the real implementation.
 */
class FakePassportStrategy extends PassportStrategy {
  public readonly name = 'fake';

  constructor(private readonly outcome: { user?: unknown; fail?: string; error?: Error }) {
    super();
  }

  authenticate(): void {
    if (this.outcome.error) {
      return this.error(this.outcome.error);
    }

    if (this.outcome.fail) {
      return this.fail({ message: this.outcome.fail } as never, 401);
    }

    this.success(this.outcome.user as never);
  }
}

function googleApp(overrides: Record<string, unknown> = {}): NexxusApplication {
  const app = makeAuthApp({
    auth: {
      strategies: { google: CONFIG },
      userDetailSchema: { default: {}, admin: {} },
      userTypes: { admin: { roles: [] } },
      ...(overrides.auth as object ?? {}),
    },
  });

  app.setAuthDetailSchema({
    [authDetailKey('google')]: {
      type: 'object', required: false, properties: NexxusGoogleAuthStrategy.userDetailSchema,
    },
  });

  return seedApp(app);
}

/** Minimal express doubles — these paths answer through `next` or `res`, not a router. */
function fakeReq(overrides: Partial<NexxusApiRequest> = {}): NexxusApiRequest {
  return { headers: { 'nxx-app-id': 'app1' }, query: {}, body: {}, ...overrides } as unknown as NexxusApiRequest;
}

function fakeRes(): NexxusApiResponse & { statusCode?: number; payload?: unknown } {
  const res: any = {
    statusCode: undefined,
    payload: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.payload = body; return res; },
  };

  return res;
}

/**
 * Wait for the response `handleCallback` sends AFTER it returns.
 *
 * The success path is `void this.sendTokenResponse(...).catch(next)` — an
 * Express handler doesn't await the response it writes, and the device lookup
 * inside it is async.
 */
async function settled(res: { payload?: unknown }, timeoutMs = 500): Promise<any> {
  const deadline = Date.now() + timeoutMs;

  while (res.payload === undefined) {
    if (Date.now() > deadline) {
      throw new Error('no response was sent');
    }

    await new Promise(resolve => setTimeout(resolve, 5));
  }

  return res.payload;
}

const storedUser = (overrides: Partial<INexxusUser> = {}): NexxusUser => new NexxusUser({
  id: 'u1', type: 'user', appId: 'app1', username: 'ann@example.com', password: null,
  authProviders: [ 'local' ], devices: [], details: {}, userType: 'default', ...overrides,
} as INexxusUser);

describe('NexxusGoogleAuthStrategy — declared metadata', () => {
  beforeEach(() => { installApiStatics(); });

  it('declares that it needs a callback route', () => {
    expect(NexxusGoogleAuthStrategy.requiresCallback).toBe(true);
  });

  it('declares the detail fields it owns, all optional', () => {
    // Optional because a profile may lack a display name, and because an
    // account created before this strategy was enabled has no subtree at all —
    // absence is how "never signed in with Google" is expressed.
    expect(NexxusGoogleAuthStrategy.userDetailSchema).toEqual({
      name: { type: 'string', required: false },
      id:   { type: 'string', required: false },
    });
  });

  it('rejects a config missing its OAuth credentials', () => {
    expect(() => new NexxusGoogleAuthStrategy({ clientID: 'x' } as never, googleApp()))
      .toThrow(/Invalid config for auth strategy "NexxusGoogleAuthStrategy"/);
  });
});

describe('NexxusGoogleAuthStrategy.handleAuth', () => {
  let strategy: NexxusGoogleAuthStrategy;

  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
    strategy = new NexxusGoogleAuthStrategy(CONFIG, googleApp());
  });

  it('refuses a user type the application has no detail schema for', async () => {
    let err: unknown;

    await strategy.handleAuth(fakeReq({ body: { userType: 'ghost' } } as never), fakeRes(), (e) => { err = e; });

    expect((err as Error).message).toMatch(/User type "ghost" not found in application "app1"/);
  });

  it('signs a state carrying a live single-use nonce', async () => {
    // Signature alone only proves nobody edited the state; the nonce is what
    // makes it unreplayable, and it must exist in Redis to be redeemable.
    let state = '';
    const real = passport.authenticate;

    (passport as any).authenticate = (_n: string, opts: any) => { state = opts.state; return () => {}; };

    try {
      await strategy.handleAuth(fakeReq(), fakeRes(), () => {});
    } finally {
      (passport as any).authenticate = real;
    }

    const payload = JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString());

    expect(payload).toMatchObject({ appId: 'app1', userType: 'default', nonce: expect.any(String) });
    await expect(NexxusAuthNonce.consume('app1', payload.nonce)).resolves.not.toBeNull();
  });
});

/**
 * The verify step: what a Google profile is allowed to turn into. Driven
 * directly rather than through the real `GoogleStrategy`, which would mean an
 * outbound OAuth round trip — everything below it is the real implementation.
 */
describe('NexxusGoogleAuthStrategy.verifyProfile', () => {
  let strategy: NexxusGoogleAuthStrategy & {
    verifyProfile(req: unknown, profile: unknown, done: (e: unknown, u?: unknown) => void): Promise<void>;
  };

  const AUTH_STATE = { appId: 'app1', userType: 'default' };

  const profile = (overrides: Record<string, unknown> = {}): unknown => ({
    id: 'google-123',
    displayName: 'Ann Example',
    emails: [ { value: 'ann@example.com', verified: true } ],
    ...overrides,
  });

  /** Run the verify step and resolve with whatever it passed to `done`. */
  function verify(profileData: unknown, authState: unknown = AUTH_STATE): Promise<{ err: unknown; user: any }> {
    return new Promise(resolve => {
      void strategy.verifyProfile(
        { headers: { 'nxx-app-id': 'app1' }, authState },
        profileData,
        (err, user) => resolve({ err, user }),
      );
    });
  }

  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
    strategy = new NexxusGoogleAuthStrategy(CONFIG, googleApp()) as never;
  });

  it('refuses to run without a verified state on the request', async () => {
    // Belt and braces behind handleCallback: the verify step must never be
    // reachable with a state nobody checked. Built inline rather than through
    // the `verify` helper — its default parameter would substitute a state.
    const err = await new Promise(resolve => {
      void strategy.verifyProfile({ headers: {} }, profile(), (e) => resolve(e));
    });

    expect((err as Error).message).toMatch(/no verified state/);
  });

  it('refuses a profile with no email', async () => {
    expect((await verify(profile({ emails: [] })).then(r => r.err) as Error).message)
      .toMatch(/No email found/);
  });

  /**
   * Accounts are matched by email, so an unverified one is account takeover:
   * register at the provider with a victim's address and this would link
   * straight into their existing account, no password needed.
   */
  it('refuses an unverified email', async () => {
    const { err, user } = await verify(profile({ emails: [ { value: 'ann@example.com', verified: false } ] }));

    expect((err as Error).message).toBe('Google account email is not verified');
    expect(user).toBeUndefined();
  });

  it('refuses the STRING "false", which a truthiness check would pass', async () => {
    const { err } = await verify(profile({ emails: [ { value: 'a@b.c', verified: 'false' } ] }));

    expect((err as Error).message).toBe('Google account email is not verified');
  });

  it('fails closed when the provider omits the claim entirely', async () => {
    // "Didn't say" is not "verified". The rule is enforced by our code rather
    // than by a provider's good behaviour.
    const { err } = await verify(profile({ emails: [ { value: 'a@b.c' } ] }));

    expect((err as Error).message).toBe('Google account email is not verified');
  });

  it('accepts the string "true"', async () => {
    const { err } = await verify(profile({ emails: [ { value: 'a@b.c', verified: 'true' } ] }));

    expect(err).toBeNull();
  });

  it('creates an account, recording what Google said under its own namespace', async () => {
    dbState.searchResult = [];

    const { user } = await verify(profile());
    const created = (dbState.created[0]![0] as NexxusUser).getData();

    expect(created.username).toBe('ann@example.com');
    expect(created.authProviders).toEqual([ 'google' ]);
    expect(created.details).toEqual({ $auth_google: { name: 'Ann Example', id: 'google-123' } });
    // The provider subtree is stripped from what the client receives.
    expect(user.details).toEqual({});
  });

  it('creates the account with the user type from the VERIFIED state', async () => {
    dbState.searchResult = [];

    await verify(profile(), { appId: 'app1', userType: 'admin' });

    expect((dbState.created[0]![0] as NexxusUser).getData().userType).toBe('admin');
  });

  it('links Google to an existing local account', async () => {
    dbState.searchResult = [ storedUser({ authProviders: [ 'local' ] }) ];

    const { user } = await verify(profile());

    // Two writes: the provider subtree (from findOrCreateUser) and the
    // authProviders append.
    const paths = dbState.updateCalls.flatMap(c => c.patches.map((p: any) => p.get().path[0]));

    expect(paths).toContain('details.$auth_google');
    expect(paths).toContain('authProviders');
    expect(user.authProviders).toContain('google');
  });

  it('does not re-append the provider when the account is already linked', async () => {
    dbState.searchResult = [ storedUser({ authProviders: [ 'local', 'google' ] }) ];

    await verify(profile());

    const paths = dbState.updateCalls.flatMap(c => c.patches.map((p: any) => p.get().path[0]));

    expect(paths).not.toContain('authProviders');
  });

  it('refreshes the provider details on every login', async () => {
    dbState.searchResult = [ storedUser({ authProviders: [ 'google' ], details: { $auth_google: { name: 'Old Name' } } }) ];

    await verify(profile());

    const patch = dbState.updateCalls[0]!.patches[0].get();

    expect(patch.value[0]).toEqual({ name: 'Ann Example', id: 'google-123' });
  });

  it('reports a failure through done rather than throwing', async () => {
    dbState.searchImpl = () => { throw new Error('elasticsearch is down'); };

    const { err } = await verify(profile());

    expect((err as Error).message).toBe('elasticsearch is down');
  });
});

describe('NexxusGoogleAuthStrategy.handleCallback — state gate', () => {
  let strategy: NexxusGoogleAuthStrategy;
  let app: NexxusApplication;

  /** Drive handleAuth to obtain a genuine signed state + live nonce. */
  async function freshState(userType = 'default', deviceId?: string): Promise<string> {
    let captured = '';
    const res = fakeRes();
    const req = fakeReq({ body: { userType, ...(deviceId ? { device: { id: deviceId } } : {}) } } as never);

    // passport.authenticate is called with the state in its options; capture it
    // by registering a strategy whose authenticate() reads them back.
    passport.use(strategy.passportName, new FakePassportStrategy({ user: null }));

    const realAuthenticate = passport.authenticate;

    (passport as any).authenticate = (_name: string, options: any) => {
      captured = options.state;

      return () => {};
    };

    try {
      await strategy.handleAuth(req, res, () => {});
    } finally {
      (passport as any).authenticate = realAuthenticate;
    }

    return captured;
  }

  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
    app = googleApp();
    strategy = new NexxusGoogleAuthStrategy(CONFIG, app);
  });

  afterEach(() => {
    passport.unuse(strategy.passportName);
  });

  it('refuses a callback with no state at all', async () => {
    let err: unknown;

    await strategy.handleCallback(fakeReq() as Request, fakeRes() as Response, (e) => { err = e; });

    expect((err as Error).message).toBe('Missing state parameter');
  });

  it('refuses a state that fails its signature', async () => {
    let err: unknown;
    const req = fakeReq({ query: { state: 'forged.signature' } } as never);

    await strategy.handleCallback(req as Request, fakeRes() as Response, (e) => { err = e; });

    expect((err as Error).message).toBe('Invalid state parameter');
  });

  /**
   * The escalation this whole mechanism exists to stop: `userType` selects the
   * ACL role the account is created with, and the parameter makes a round trip
   * through the caller's browser.
   */
  it('refuses a state whose userType was edited in transit', async () => {
    const state = await freshState('default');
    const [ , mac ] = state.split('.');
    const payload = JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, userType: 'admin' })).toString('base64url');

    let err: unknown;

    await strategy.handleCallback(
      fakeReq({ query: { state: `${forged}.${mac}` } } as never) as Request, fakeRes() as Response, (e) => { err = e; },
    );

    expect((err as Error).message).toBe('Invalid state parameter');
  });

  it('refuses a replayed callback', async () => {
    const state = await freshState();

    passport.use(strategy.passportName, new FakePassportStrategy({ fail: 'nope' }));

    // First use redeems the nonce.
    await strategy.handleCallback(
      fakeReq({ query: { state } } as never) as Request, fakeRes() as Response, () => {},
    );

    let err: unknown;

    await strategy.handleCallback(
      fakeReq({ query: { state } } as never) as Request, fakeRes() as Response, (e) => { err = e; },
    );

    expect((err as Error).message).toBe('Expired or already used state parameter');
  });

  it('refuses a signed state whose nonce was never issued', async () => {
    const state = await freshState();
    const payload = JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString());

    await NexxusAuthNonce.consume('app1', payload.nonce);

    let err: unknown;

    await strategy.handleCallback(
      fakeReq({ query: { state } } as never) as Request, fakeRes() as Response, (e) => { err = e; },
    );

    expect((err as Error).message).toBe('Expired or already used state parameter');
  });

  it('hands the verified payload to the request rather than re-parsing the query', async () => {
    const state = await freshState('admin');
    const req = fakeReq({ query: { state } } as never);

    passport.use(strategy.passportName, new FakePassportStrategy({ fail: 'stop here' }));

    await strategy.handleCallback(req as Request, fakeRes() as Response, () => {});

    // The verify callback reads THIS, never req.query.state — so what it acts
    // on is the payload whose signature and nonce were just proven.
    expect(req.authState).toEqual({ appId: 'app1', userType: 'admin' });
  });

  it('answers 401 when the provider declines the user', async () => {
    const state = await freshState();

    passport.use(strategy.passportName, new FakePassportStrategy({ fail: 'access_denied' }));

    const res = fakeRes();

    await strategy.handleCallback(fakeReq({ query: { state } } as never) as Request, res as Response, () => {});

    expect(res.statusCode).toBe(401);
  });

  it('forwards a provider error to the error middleware', async () => {
    const state = await freshState();

    passport.use(strategy.passportName, new FakePassportStrategy({ error: new Error('google is down') }));

    let err: unknown;

    await strategy.handleCallback(
      fakeReq({ query: { state } } as never) as Request, fakeRes() as Response, (e) => { err = e; },
    );

    expect((err as Error).message).toBe('google is down');
  });

  it('completes the login with a token bound to a device', async () => {
    const state = await freshState();
    const user = NexxusAuthStrategy.convertToApiUser(storedUser());

    passport.use(strategy.passportName, new FakePassportStrategy({ user }));

    const res = fakeRes();

    await strategy.handleCallback(fakeReq({ query: { state } } as never) as Request, res as Response, () => {});

    const payload = await settled(res);

    expect(payload.token).toEqual(expect.any(String));
    expect(payload.device.id).toEqual(expect.any(String));
    expect(payload.user).toEqual({ id: 'u1', username: 'ann@example.com' });
  });

  it('carries the device hint through the redirect inside the signed state', async () => {
    // Register the device the hint will name, so it can actually be reused.
    const firstState = await freshState();
    const user = NexxusAuthStrategy.convertToApiUser(storedUser());

    passport.use(strategy.passportName, new FakePassportStrategy({ user }));

    const first = fakeRes();

    await strategy.handleCallback(fakeReq({ query: { state: firstState } } as never) as Request, first as Response, () => {});

    const deviceId = (await settled(first)).device.id;
    const secondState = await freshState('default', deviceId);

    passport.use(strategy.passportName, new FakePassportStrategy({ user }));

    const second = fakeRes();

    await strategy.handleCallback(fakeReq({ query: { state: secondState } } as never) as Request, second as Response, () => {});

    // A redirect flow has no request body, so the hint could only have survived
    // the round trip inside the signed state.
    expect((await settled(second)).device.id).toBe(deviceId);
  });
});
