import { describe, it, expect } from 'vitest';
import {
  NexxusToken,
  NexxusApplication,
  TokenExpiredException,
  InvalidTokenException,
  type NexxusTokenMint,
  type INexxusApplication
} from '@mayhem93/nexxus-core-lib';

import jwt from 'jsonwebtoken';

const SECRET = 'signing-secret';

/** A valid application, with per-test overrides. */
const makeApp = (overrides: Record<string, unknown> = {}): NexxusApplication => new NexxusApplication({
  id: 'app1',
  type: 'application',
  name: 'Test App',
  signingSecret: SECRET,
  schema: { runs: { fields: { note: { type: 'string', required: false } } } },
  ...overrides,
} as INexxusApplication);

/** Minimal auth block, for the cases that need `jwtExpiresIn`. */
const withExpiry = (jwtExpiresIn: string): NexxusApplication => makeApp({
  auth: { jwtExpiresIn, strategies: { local: {} }, userDetailSchema: { default: {} } },
});

/** The smallest valid thing to mint: a device, no principal. */
const deviceOnly: NexxusTokenMint = { appId: 'app1', deviceId: 'd1' };

const USER = {
  id: 'u1', username: 'ann', userType: 'default',
  authProviders: [ 'local' ], details: {}, appId: 'app1',
} as never;

/** Claims as they actually sit in the token, without verifying anything. */
const decode = (token: string): Record<string, any> => jwt.decode(token) as Record<string, any>;

/** Sign arbitrary claims with an app's key — for tokens `issue` would refuse to make. */
const signRaw = (app: NexxusApplication, claims: object): string =>
  jwt.sign(claims, app.getSigningSecret(), { audience: app.getData().id as string, expiresIn: '5m' });

describe('NexxusToken.issue', () => {
  it('round-trips a device-only token', () => {
    const app = makeApp();
    const claims = NexxusToken.verify(app, NexxusToken.issue(app, deviceOnly));

    expect(claims).toMatchObject({ appId: 'app1', deviceId: 'd1' });
    expect(claims.user).toBeUndefined();
  });

  it('round-trips a token carrying a user', () => {
    const app = makeApp();
    const claims = NexxusToken.verify(app, NexxusToken.issue(app, { ...deviceOnly, user: USER }));

    expect(claims.user).toMatchObject({ id: 'u1', username: 'ann' });
  });

  it('signs with the application\'s own key', () => {
    const token = NexxusToken.issue(makeApp(), deviceOnly);

    expect(() => jwt.verify(token, SECRET)).not.toThrow();
    expect(() => jwt.verify(token, 'some-other-secret')).toThrow();
  });

  /**
   * `aud` comes from the application, NOT from the claims — a token is stamped
   * with the app that actually issued it, so a caller can't mislabel one by
   * passing a different appId in.
   */
  it('stamps the audience from the application, not from the claims', () => {
    const token = NexxusToken.issue(makeApp(), { ...deviceOnly, appId: 'a-different-app' });

    expect(decode(token).aud).toBe('app1');
  });

  it('stamps a fixed issuer', () => {
    expect(decode(NexxusToken.issue(makeApp(), deviceOnly)).iss).toBe('nexxus');
  });

  it('defaults to a 7 day lifetime when the application declares none', () => {
    const claims = decode(NexxusToken.issue(makeApp(), deviceOnly));

    expect(claims.exp - claims.iat).toBe(7 * 24 * 60 * 60);
  });

  it('honours the application\'s configured lifetime', () => {
    const claims = decode(NexxusToken.issue(withExpiry('15m'), deviceOnly));

    expect(claims.exp - claims.iat).toBe(15 * 60);
  });
});

describe('NexxusToken.verify — signature and audience', () => {
  it('rejects a token signed with a different key', () => {
    const token = NexxusToken.issue(makeApp({ signingSecret: 'impostor-secret' }), deviceOnly);

    expect(() => NexxusToken.verify(makeApp(), token)).toThrow(InvalidTokenException);
  });

  /**
   * Redundant while keys are per-application, but it costs nothing and catches
   * the one realistic misconfiguration: the same secret in two app documents.
   */
  it('rejects a token issued for a different application on the same key', () => {
    const other = makeApp({ id: 'app2' });
    const token = NexxusToken.issue(other, { appId: 'app2', deviceId: 'd1' });

    expect(() => NexxusToken.verify(makeApp(), token)).toThrow(InvalidTokenException);
    expect(() => NexxusToken.verify(other, token)).not.toThrow();
  });

  it('distinguishes expiry from every other failure', async () => {
    const app = withExpiry('1ms');
    const token = NexxusToken.issue(app, deviceOnly);

    await new Promise(resolve => setTimeout(resolve, 20));

    // Expiry is the one verification failure a client can act on by
    // re-authenticating, so it must not be lumped in with "invalid".
    expect(() => NexxusToken.verify(app, token)).toThrow(TokenExpiredException);
  });

  it('rejects malformed input rather than leaking a library error', () => {
    const app = makeApp();

    for (const bad of [ '', 'not-a-jwt', 'a.b.c', '{}' ]) {
      expect(() => NexxusToken.verify(app, bad)).toThrow(InvalidTokenException);
    }
  });

  it('rejects a token whose payload was edited', () => {
    const app = makeApp();
    const token = NexxusToken.issue(app, deviceOnly);
    const [ header, , signature ] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...decode(token), deviceId: 'someone-elses' }))
      .toString('base64url');

    expect(() => NexxusToken.verify(app, `${header}.${forged}.${signature}`)).toThrow(InvalidTokenException);
  });
});

/**
 * A signature proves a token wasn't edited. It proves nothing about what's
 * inside one — so the claim shape is checked here, once, and every consumer
 * relies on the result instead of re-checking it.
 */
describe('NexxusToken.verify — claim shape', () => {
  it('rejects a correctly signed token carrying no device', () => {
    const app = makeApp();

    expect(() => NexxusToken.verify(app, signRaw(app, { appId: 'app1' })))
      .toThrow(/Token carries no device/);
  });

  it('rejects a correctly signed token naming no application', () => {
    const app = makeApp();

    expect(() => NexxusToken.verify(app, signRaw(app, { deviceId: 'd1' })))
      .toThrow(/does not name an application/);
  });

  it('rejects non-string appId and deviceId', () => {
    const app = makeApp();

    expect(() => NexxusToken.verify(app, signRaw(app, { appId: 1, deviceId: 'd1' }))).toThrow(InvalidTokenException);
    expect(() => NexxusToken.verify(app, signRaw(app, { appId: 'app1', deviceId: 42 }))).toThrow(InvalidTokenException);
  });

  it('rejects an EMPTY appId or deviceId', () => {
    // An empty string is a string. Letting one through would satisfy the type
    // while naming nothing, so a consumer that trusts the shape — and the point
    // of validating here is that they all do — would look up the device "".
    const app = makeApp();

    expect(() => NexxusToken.verify(app, signRaw(app, { appId: '', deviceId: 'd1' })))
      .toThrow(/does not name an application/);
    expect(() => NexxusToken.verify(app, signRaw(app, { appId: 'app1', deviceId: '' })))
      .toThrow(/carries no device/);
  });

  it('rejects a malformed user claim', () => {
    const app = makeApp();

    for (const user of [ 'ann', 42, null ]) {
      expect(() => NexxusToken.verify(app, signRaw(app, { ...deviceOnly, user })))
        .toThrow(/malformed user/);
    }
  });

  it('narrows on user presence', () => {
    const app = makeApp();
    const claims = NexxusToken.verify(app, NexxusToken.issue(app, { ...deviceOnly, user: USER }));

    // `user` presence is the discriminant — no tag claim in the token.
    if (claims.user) {
      expect(claims.user.username).toBe('ann');
    } else {
      throw new Error('expected the user variant');
    }
  });
});

describe('NexxusToken.peekAppId', () => {
  it('reads the appId without the key that signed it', () => {
    // The whole point: a transport worker holds a token and no context, and has
    // to find the application before it can verify anything.
    const token = NexxusToken.issue(makeApp({ signingSecret: 'a-key-we-do-not-have' }), deviceOnly);

    expect(NexxusToken.peekAppId(token)).toBe('app1');
  });

  it('returns null when there is no appId to read', () => {
    expect(NexxusToken.peekAppId(jwt.sign({ deviceId: 'd1' }, SECRET))).toBeNull();
  });

  it('returns null for anything that is not a readable token', () => {
    for (const bad of [ '', 'not-a-jwt', 'a.b.c', undefined as never, 42 as never, null as never ]) {
      expect(NexxusToken.peekAppId(bad)).toBeNull();
    }
  });

  it('returns null for a non-object payload', () => {
    // A JWT whose payload is a bare string is structurally valid and decodes to
    // something with no claims to read.
    expect(NexxusToken.peekAppId(jwt.sign('just-a-string', SECRET))).toBeNull();
  });

  /**
   * What it returns is UNVERIFIED — it only selects which key to verify
   * against. A forged appId points at a different application, whose key then
   * fails the signature.
   */
  it('is not proof of anything on its own', () => {
    const forged = NexxusToken.issue(makeApp({ id: 'app2', signingSecret: 'app2-secret' }), deviceOnly);

    expect(NexxusToken.peekAppId(forged)).toBe('app1');
    expect(() => NexxusToken.verify(makeApp(), forged)).toThrow(InvalidTokenException);
  });
});
