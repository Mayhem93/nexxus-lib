import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  NexxusToken,
  NexxusUser,
  authDetailKey,
  type INexxusUser,
  type NexxusApplication,
  type NexxusUserDetailSchema,
} from '@mayhem93/nexxus-core-lib';

import NexxusAuthStrategy, { type NexxusAuthStatePayload } from '../../src/api/src/lib/auth/AuthStrategy';
import { InvalidParametersException } from '../../src/api/src/lib/Exceptions';
import type { NexxusApiUser } from '../../src/api/src/lib/Api';

import { installApiStatics, seedApp, makeAuthApp, dbState, startTestServer, type TestServer } from './harness';
import { installFakeRedis } from '../redis/helpers';

import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response, RequestHandler } from 'express';

/**
 * A concrete strategy, so the abstract base can be exercised directly. The
 * protected surface is re-exposed rather than reached into with casts — these
 * ARE the extension points a real strategy uses, so calling them the way a
 * subclass would is closer to the truth than poking at the instance.
 *
 * `schemaPath` points at the local strategy's config schema (an empty object,
 * no additional properties) because config validation is being tested here, not
 * any particular strategy's config shape.
 */
class TestStrategy extends NexxusAuthStrategy {
  readonly name = 'test';
  protected static schemaPath: string = path.join(
    process.cwd(), 'src/api/src/schemas/local-auth-strategy.schema.json',
  );

  static readonly userDetailSchema = {
    nickname: { type: 'string', required: false },
    remoteId: { type: 'string', required: false },
  } as const satisfies NexxusUserDetailSchema;

  handleAuth(_req: Request, _res: Response, _next: NextFunction): void {}
  handleCallback(_req: Request, _res: Response, _next: NextFunction): void {}

  public sign(payload: NexxusAuthStatePayload): string { return this.signState(payload); }
  public verify(state: string): NexxusAuthStatePayload | null { return this.verifyState(state); }
  public token(user: NexxusApiUser, deviceId: string): string { return this.generateToken(user, deviceId); }
  public namespaceKey(): string { return this.authDetailKey; }
  public details(userType: string, d: Record<string, any>): Record<string, any> {
    return this.validateUserDetails(userType, d);
  }
  public ownDetails(d: Record<string, any>): Record<string, any> { return this.validateOwnAuthDetails(d); }
  public findOrCreate(data: {
    username: string;
    userType?: string;
    authProvider: string;
    authDetails?: Record<string, any>;
  }): Promise<[ NexxusUser, 'found' | 'created' ]> {
    return this.findOrCreateUser(data as never);
  }

  public static checkPassword(password: string, hash: string): Promise<boolean> {
    return TestStrategy.verifyPassword(password, hash);
  }
}

const STATE: NexxusAuthStatePayload = { appId: 'app1', userType: 'default', nonce: 'n1' };

const USER = {
  id: 'u1', username: 'ann', userType: 'default',
  authProviders: [ 'local' ], details: {}, appId: 'app1',
} as NexxusApiUser;

/** The app, with this strategy's `$auth_test` namespace registered as the API does at boot. */
function authApp(overrides: Record<string, unknown> = {}): NexxusApplication {
  const app = makeAuthApp(overrides);

  app.setAuthDetailSchema({
    [authDetailKey('test')]: { type: 'object', required: false, properties: TestStrategy.userDetailSchema },
  });

  return seedApp(app);
}

const storedUser = (overrides: Partial<INexxusUser> = {}): NexxusUser => new NexxusUser({
  id: 'u1', type: 'user', appId: 'app1', username: 'ann', password: null,
  authProviders: [ 'local' ], devices: [], details: {},
  userType: 'default', ...overrides,
} as INexxusUser);

describe('NexxusAuthStrategy — construction', () => {
  beforeEach(() => { installApiStatics(); });

  it('accepts a config its schema allows', () => {
    expect(() => new TestStrategy({}, authApp())).not.toThrow();
  });

  it('rejects a config its schema forbids, naming the offending key', () => {
    // The key comes from AJV's `params`, not its message — a boot-time config
    // error that doesn't say which key is wrong makes an operator hunt for it.
    expect(() => new TestStrategy({ nope: 1 }, authApp()))
      .toThrow(/Invalid config for auth strategy "TestStrategy".*"nope"/s);
  });

  it('derives appId from the application rather than storing a copy', () => {
    const app = authApp();
    const strategy = new TestStrategy({}, app);

    expect(strategy.passportName).toBe(`test:${app.getData().id}`);
  });

  it('namespaces its passport registration per application', () => {
    // Two apps using the same strategy type need isolated Passport
    // registrations — OAuth config varies per tenant.
    expect(new TestStrategy({}, authApp()).passportName)
      .not.toBe(new TestStrategy({}, seedApp(makeAuthApp({ id: 'app2' }))).passportName);
  });
});

describe('NexxusAuthStrategy — redirect state signing', () => {
  let strategy: TestStrategy;

  beforeEach(() => {
    installApiStatics();
    strategy = new TestStrategy({}, authApp());
  });

  it('round-trips a payload', () => {
    expect(strategy.verify(strategy.sign(STATE))).toEqual(STATE);
  });

  it('carries an optional device hint through', () => {
    const withDevice = { ...STATE, deviceId: 'd1' };

    expect(strategy.verify(strategy.sign(withDevice))).toEqual(withDevice);
  });

  /**
   * The reason this exists: `userType` selects the ACL role, and a redirect flow
   * hands the parameter to the client for the round trip. Unsigned, a caller
   * could award themselves any user type the application declares.
   */
  it('rejects a payload edited in transit', () => {
    const [ , mac ] = strategy.sign(STATE).split('.');
    const forged = Buffer.from(JSON.stringify({ ...STATE, userType: 'admin' })).toString('base64url');

    expect(strategy.verify(`${forged}.${mac}`)).toBeNull();
  });

  it('rejects a state signed with another application\'s key', () => {
    const other = new TestStrategy({}, seedApp(makeAuthApp({ id: 'app1', signingSecret: 'different' })));

    expect(strategy.verify(other.sign(STATE))).toBeNull();
  });

  it('rejects a state naming a different application than the strategy serves', () => {
    // Belt and braces over the signature: the binding is asserted rather than
    // assumed from how the router picked this instance.
    const app2 = seedApp(makeAuthApp({ id: 'app2' }));
    const other = new TestStrategy({}, app2);

    expect(other.verify(other.sign({ ...STATE, appId: 'app2' }))).not.toBeNull();
    expect(strategy.verify(other.sign({ ...STATE, appId: 'app2' }))).toBeNull();
  });

  it('rejects structurally malformed states', () => {
    for (const bad of [ '', 'nodot', 'a.b.c', '.', 'x.', '.y', 42 as never, null as never ]) {
      expect(strategy.verify(bad)).toBeNull();
    }
  });

  it('rejects a body that is not base64url JSON', () => {
    expect(strategy.verify('!!!not-base64!!!.mac')).toBeNull();
  });

  it('rejects a payload missing any required claim', () => {
    // Signed with the right key, but shaped wrong — the signature proves nobody
    // edited it, not that what's inside makes sense.
    for (const partial of [ { userType: 'x', nonce: 'n' }, { appId: 'app1', nonce: 'n' }, { appId: 'app1', userType: 'x' } ]) {
      expect(strategy.verify(strategy.sign(partial as never))).toBeNull();
    }
  });

  it('drops a malformed device hint rather than failing the whole state', () => {
    const signed = strategy.sign({ ...STATE, deviceId: 42 } as never);

    expect(strategy.verify(signed)).toEqual(STATE);
  });

  it('is derived from a key SEPARATE from the token signing secret', () => {
    // Key separation: a weakness in redirect-state signing must not be
    // pivotable into minting access tokens.
    const app = authApp();
    const state = new TestStrategy({}, app).sign(STATE);
    const [ body, mac ] = state.split('.');

    const naive = createHmac('sha256', app.getSigningSecret()).update(body!).digest('base64url');

    expect(mac).not.toBe(naive);
  });
});

describe('NexxusAuthStrategy.peekStateAppId', () => {
  let strategy: TestStrategy;

  beforeEach(() => {
    installApiStatics();
    strategy = new TestStrategy({}, authApp());
  });

  it('reads the appId without the key that signed it', () => {
    // The router has to find the application before it can verify anything.
    expect(NexxusAuthStrategy.peekStateAppId(strategy.sign(STATE))).toBe('app1');
  });

  it('returns null for anything unreadable', () => {
    for (const bad of [ '', 'nope', '!!!.x', 42 as never, null as never ]) {
      expect(NexxusAuthStrategy.peekStateAppId(bad)).toBeNull();
    }
  });

  it('is not proof of anything on its own', () => {
    // A forged appId selects a different key, and verification then fails.
    const forged = Buffer.from(JSON.stringify({ ...STATE, appId: 'app2' })).toString('base64url');

    expect(NexxusAuthStrategy.peekStateAppId(`${forged}.whatever`)).toBe('app2');
    expect(strategy.verify(`${forged}.whatever`)).toBeNull();
  });
});

describe('NexxusAuthStrategy — user details', () => {
  let strategy: TestStrategy;

  beforeEach(() => {
    installApiStatics();
    strategy = new TestStrategy({}, authApp({
      auth: {
        strategies: { local: {} },
        userDetailSchema: { default: { age: { type: 'int', required: false } } },
      },
    }));
  });

  it('accepts and normalizes declared fields', () => {
    expect(strategy.details('default', { age: 30 })).toEqual({ age: 30 });
  });

  it('accepts an empty details object', () => {
    expect(strategy.details('default', {})).toEqual({});
  });

  it('rejects a field the application never declared', () => {
    // The schema is closed, so registration can't pollute the user index with
    // whatever a client felt like sending.
    expect(() => strategy.details('default', { favouriteColour: 'blue' }))
      .toThrow(/not declared in the schema/);
  });

  it('rejects a declared field of the wrong type', () => {
    expect(() => strategy.details('default', { age: 'thirty' })).toThrow(InvalidParametersException);
  });

  /**
   * The load-bearing one. `getUserDetailSchema` merges the `$auth_*` namespaces
   * in, so the schema DOES declare `$auth_test` — without this check a
   * registration body carrying one would validate cleanly and mint an account
   * pre-linked to someone else's provider identity. Schema membership answers
   * "is this a real field", not "may this caller write it".
   */
  it('refuses a reserved $ field supplied by the caller', () => {
    expect(() => strategy.details('default', { [authDetailKey('test')]: { remoteId: 'victim' } }))
      .toThrow(/are set by Nexxus and cannot be supplied/);
  });

  it('refuses any $-prefixed field, not just a known strategy namespace', () => {
    expect(() => strategy.details('default', { $anything: 1 })).toThrow(/cannot be supplied/);
  });

  it('rejects a user type the application has no schema for', () => {
    expect(() => strategy.details('ghost', {})).toThrow(/No user detail schema for user type "ghost"/);
  });
});

describe('NexxusAuthStrategy — own auth details', () => {
  let strategy: TestStrategy;

  beforeEach(() => {
    installApiStatics();
    strategy = new TestStrategy({}, authApp());
  });

  it('names its namespace after the strategy', () => {
    expect(strategy.namespaceKey()).toBe('$auth_test');
  });

  it('accepts the fields the strategy class declares', () => {
    expect(strategy.ownDetails({ nickname: 'ann', remoteId: 'x1' })).toEqual({ nickname: 'ann', remoteId: 'x1' });
  });

  it('rejects a field the strategy class does not declare', () => {
    // Checked against the STRATEGY's schema, not the app's merged one, so one
    // provider's mapping bug can't write into another's namespace or into the
    // developer's own fields.
    expect(() => strategy.ownDetails({ age: 30 })).toThrow(/not declared in the schema/);
  });

  it('rejects a declared field of the wrong type', () => {
    expect(() => strategy.ownDetails({ nickname: 42 })).toThrow(InvalidParametersException);
  });
});

describe('NexxusAuthStrategy.convertToApiUser', () => {
  beforeEach(() => { installApiStatics(); });

  it('projects the fields a client needs', () => {
    expect(NexxusAuthStrategy.convertToApiUser(storedUser({ details: { age: 30 } }))).toEqual({
      id: 'u1', username: 'ann', userType: 'default',
      authProviders: [ 'local' ], details: { age: 30 }, appId: 'app1',
    });
  });

  it('never carries the password hash', () => {
    const user = NexxusAuthStrategy.convertToApiUser(storedUser({ password: 'hashed' } as never));

    expect(user).not.toHaveProperty('password');
  });

  /**
   * This object becomes the token's `user` claim, so it rides in the
   * Authorization header of every request and is returned verbatim by
   * `/user/me`. Provider bookkeeping belongs in neither — `authProviders`
   * already tells a client which providers are linked.
   */
  it('strips reserved $ details', () => {
    const user = NexxusAuthStrategy.convertToApiUser(storedUser({
      details: { age: 30, $auth_google: { id: 'g1' }, $auth_test: { nickname: 'ann' } },
    }));

    expect(user.details).toEqual({ age: 30 });
  });

  it('tolerates a user with no details at all', () => {
    expect(NexxusAuthStrategy.convertToApiUser(storedUser({ details: undefined })).details).toEqual({});
  });
});

describe('NexxusAuthStrategy — user lookup and creation', () => {
  let strategy: TestStrategy;

  beforeEach(() => {
    installApiStatics();
    strategy = new TestStrategy({}, authApp());
  });

  it('searches within its OWN application', async () => {
    // No appId parameter to get wrong: the instance serves exactly one app.
    await strategy.findUserByUsername('ann');

    expect(dbState.searchCalls[0]).toMatchObject({ appId: 'app1', type: 'user' });
  });

  it('returns the first match, or null', async () => {
    dbState.searchResult = [ storedUser() ];
    expect((await strategy.findUserByUsername('ann'))?.getData().username).toBe('ann');

    dbState.searchResult = [];
    expect(await strategy.findUserByUsername('nobody')).toBeNull();
  });

  it('creates a user bound to its own application', async () => {
    await strategy.createUser({ username: 'ann', authProviders: [ 'local' ] });

    const created = dbState.created[0]![0] as NexxusUser;

    expect(created.getData()).toMatchObject({ appId: 'app1', username: 'ann', userType: 'default', devices: [] });
  });

  it('defaults the user type', async () => {
    await strategy.createUser({ username: 'ann', authProviders: [ 'local' ] });

    expect((dbState.created[0]![0] as NexxusUser).getData().userType).toBe('default');
  });

  it('validates the caller-supplied details before storing them', async () => {
    await expect(strategy.createUser({
      username: 'ann', authProviders: [ 'local' ], details: { undeclared: 1 },
    })).rejects.toThrow(/not declared in the schema/);

    expect(dbState.created).toHaveLength(0);
  });

  it('stores its own auth details under its namespace', async () => {
    await strategy.createUser({
      username: 'ann', authProviders: [ 'test' ], authDetails: { nickname: 'annie', remoteId: 'x1' },
    });

    expect((dbState.created[0]![0] as NexxusUser).getData().details).toEqual({
      $auth_test: { nickname: 'annie', remoteId: 'x1' },
    });
  });

  it('leaves the password null when none is supplied', async () => {
    await strategy.createUser({ username: 'ann', authProviders: [ 'test' ] });

    expect((dbState.created[0]![0] as NexxusUser).getData().password).toBeNull();
  });

  it('hashes a supplied password rather than storing it', async () => {
    await strategy.createUser({ username: 'ann', password: 'hunter2', authProviders: [ 'local' ] });

    const stored = (dbState.created[0]![0] as NexxusUser).getData().password!;

    expect(stored).not.toBe('hunter2');
    expect(stored).toMatch(/^\$2[aby]\$/); // bcrypt
  });
});

describe('NexxusAuthStrategy.findOrCreateUser', () => {
  let strategy: TestStrategy;

  beforeEach(() => {
    installApiStatics();
    strategy = new TestStrategy({}, authApp());
  });

  it('creates when no account has that username', async () => {
    dbState.searchResult = [];

    const [ user, status ] = await strategy.findOrCreate({
      username: 'ann', authProvider: 'test', authDetails: { nickname: 'annie' },
    });

    expect(status).toBe('created');
    expect(user.getData().details).toEqual({ $auth_test: { nickname: 'annie' } });
    expect(dbState.created).toHaveLength(1);
  });

  it('finds an existing account rather than creating a second', async () => {
    dbState.searchResult = [ storedUser() ];

    const [ , status ] = await strategy.findOrCreate({ username: 'ann', authProvider: 'test' });

    expect(status).toBe('found');
    expect(dbState.created).toHaveLength(0);
  });

  /**
   * The found branch is how an EXISTING account gets linked to this provider.
   * It used to drop the provider's details entirely, which left an account
   * marked as linked with no record of what the provider said about it — the
   * same as not being linked.
   */
  it('writes the provider details when linking an existing account', async () => {
    dbState.searchResult = [ storedUser() ];

    const [ user ] = await strategy.findOrCreate({
      username: 'ann', authProvider: 'test', authDetails: { nickname: 'annie' },
    });

    const patches = dbState.updateCalls[0]!.patches;

    expect(patches[0].get()).toMatchObject({
      op: 'replace', path: [ 'details.$auth_test' ], value: [ { nickname: 'annie' } ],
    });
    // Mirrored onto the in-memory model so the caller doesn't re-read.
    expect(user.getData().details).toMatchObject({ $auth_test: { nickname: 'annie' } });
  });

  it('touches updatedAt when it links', async () => {
    dbState.searchResult = [ storedUser() ];

    await strategy.findOrCreate({ username: 'ann', authProvider: 'test', authDetails: { nickname: 'a' } });

    expect(dbState.updateCalls[0]!.patches[1].get()).toMatchObject({ path: [ 'updatedAt' ] });
  });

  it('writes nothing when the provider supplied no details', async () => {
    dbState.searchResult = [ storedUser() ];

    await strategy.findOrCreate({ username: 'ann', authProvider: 'test' });

    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('refuses to write provider details the strategy does not declare', async () => {
    dbState.searchResult = [ storedUser() ];

    await expect(strategy.findOrCreate({
      username: 'ann', authProvider: 'test', authDetails: { rogue: 1 },
    })).rejects.toThrow(/not declared in the schema/);

    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('preserves the developer-declared details already on the account', async () => {
    dbState.searchResult = [ storedUser({ details: { age: 30 } }) ];

    const [ user ] = await strategy.findOrCreate({
      username: 'ann', authProvider: 'test', authDetails: { nickname: 'annie' },
    });

    expect(user.getData().details).toEqual({ age: 30, $auth_test: { nickname: 'annie' } });
  });
});

describe('NexxusAuthStrategy.generateToken', () => {
  beforeEach(() => { installApiStatics(); });

  it('mints a token this application can verify', () => {
    const app = authApp();
    const claims = NexxusToken.verify(app, new TestStrategy({}, app).token(USER, 'd1'));

    expect(claims).toMatchObject({ appId: 'app1', deviceId: 'd1' });
    expect(claims.user).toMatchObject({ id: 'u1' });
  });

  it('binds the token to the application it was issued by, not the user\'s appId', () => {
    const app2 = seedApp(makeAuthApp({ id: 'app2' }));
    const token = new TestStrategy({}, app2).token(USER, 'd1');

    // USER.appId says app1; the issuing strategy serves app2 and wins.
    expect(NexxusToken.verify(app2, token).appId).toBe('app2');
  });
});

describe('NexxusAuthStrategy.sendTokenResponse', () => {
  let server: TestServer;
  let strategy: TestStrategy;

  beforeEach(async () => {
    installApiStatics();
    installFakeRedis();
    strategy = new TestStrategy({}, authApp());

    server = await startTestServer(app => {
      app.post('/login', (async (req, res) => {
        await strategy.sendTokenResponse(res, USER, req.body?.device);
      }) as RequestHandler);
    });
  });

  afterEach(async () => { await server.close(); });

  const login = (device?: unknown) => server.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(device ? { device } : {}),
  });

  it('returns a token, the device it is bound to, and the user', async () => {
    const res = await login();

    expect(res.status).toBe(200);
    expect(res.body.device.id).toEqual(expect.any(String));
    expect(res.body.user).toEqual({ id: 'u1', username: 'ann' });
  });

  it('binds the token to the resolved device', async () => {
    // Every strategy funnels through here, so none of them can forget to bind a
    // token to a device.
    const res = await login();
    const claims = NexxusToken.verify(authApp(), res.body.token);

    expect(claims.deviceId).toBe(res.body.device.id);
  });

  it('reuses the device the client hinted at', async () => {
    const first = await login();
    const second = await login({ id: first.body.device.id });

    // What stops a 7-day token expiring from producing a new device record
    // every week.
    expect(second.body.device.id).toBe(first.body.device.id);
  });

  it('issues a new device for a stale hint instead of failing', async () => {
    const res = await login({ id: 'a-device-that-was-reaped' });

    expect(res.status).toBe(200);
    expect(res.body.device.id).not.toBe('a-device-that-was-reaped');
  });

  it('never returns the password or the full user record', async () => {
    const res = await login();

    expect(Object.keys(res.body.user)).toEqual([ 'id', 'username' ]);
  });
});

describe('NexxusAuthStrategy — password hashing', () => {
  beforeEach(() => { installApiStatics(); });

  it('produces a verifiable hash, different every time', async () => {
    const a = await NexxusAuthStrategy.hashPassword('hunter2');
    const b = await NexxusAuthStrategy.hashPassword('hunter2');

    // Salted, so identical passwords must not produce identical hashes.
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\$2[aby]\$/);
  });

  it('returns a promise rather than blocking the event loop', () => {
    // bcrypt at cost 10 is tens of milliseconds of CPU; the sync variants ran
    // that on the event loop and stalled every concurrent request behind each
    // login.
    expect(NexxusAuthStrategy.hashPassword('hunter2')).toBeInstanceOf(Promise);
    expect(TestStrategy.checkPassword('hunter2', '$2b$10$invalid')).toBeInstanceOf(Promise);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await NexxusAuthStrategy.hashPassword('hunter2');

    expect(await TestStrategy.checkPassword('hunter2', hash)).toBe(true);
    expect(await TestStrategy.checkPassword('hunter3', hash)).toBe(false);
  });
});
