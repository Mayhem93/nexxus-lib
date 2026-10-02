import { describe, it, expect, beforeEach } from 'vitest';
import { NexxusToken, NexxusUser, type INexxusUser, type NexxusApplication } from '@mayhem93/nexxus-core-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';

import { NexxusApiSession } from '../../src/api/src/lib/Session';
import { InvalidRefreshTokenException } from '../../src/api/src/lib/Exceptions';

import { installApiStatics, seedApp, makeApp, makeAuthApp, dbState, mqState, logger } from './harness';
import { installFakeRedis } from '../redis/helpers';
import type { FakeRedis } from '../redis/fakeRedis';

const USER = {
  id: 'u1', username: 'ann', userType: 'default',
  authProviders: [ 'local' ], details: {}, appId: 'app1',
} as never;

const DAY = 24 * 60 * 60;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The secret half of a refresh token — everything after its last '.'. */
const secretOf = (refreshToken: string): string => refreshToken.slice(refreshToken.lastIndexOf('.') + 1);

describe('NexxusApiSession.issue', () => {
  let redis: FakeRedis;
  let app: NexxusApplication;
  let device: NexxusDevice;

  beforeEach(async () => {
    installApiStatics();
    redis = installFakeRedis();
    app = seedApp(makeAuthApp());
    device = new NexxusDevice({ id: 'd1', appId: 'app1', name: 'Phone', subscriptions: [] });

    await device.save();
  });

  const storedSession = (): any => (redis.store.get(NexxusDevice.getKey('d1')) as { value: any }).value.session;

  it('mints an access token this application can verify, naming the device and the user', async () => {
    const { token } = await NexxusApiSession.issue(app, device, USER);
    const claims = NexxusToken.verify(app, token);

    expect(claims).toMatchObject({ appId: 'app1', deviceId: 'd1' });
    expect(claims.user).toMatchObject({ id: 'u1' });
  });

  it('binds the access token to the issuing application, not the user\'s appId', async () => {
    const app2 = seedApp(makeAuthApp({ id: 'app2' }));
    const { token } = await NexxusApiSession.issue(app2, device, USER);

    // USER.appId says app1; the issuing application wins.
    expect(NexxusToken.verify(app2, token).appId).toBe('app2');
  });

  it('issues a device-only session on an application without authentication', async () => {
    const zeroAuth = seedApp(makeApp());
    const { token, refreshToken } = await NexxusApiSession.issue(zeroAuth, device);

    expect(NexxusToken.verify(zeroAuth, token).user).toBeUndefined();
    expect(refreshToken.startsWith('d1.')).toBe(true);
  });

  it('shapes the refresh token as <deviceId>.<secret>, with 256 random bits of secret', async () => {
    const { refreshToken } = await NexxusApiSession.issue(app, device, USER);

    // 32 bytes in base64url is 43 characters, and the alphabet has no '.'.
    expect(refreshToken).toMatch(/^d1\.[A-Za-z0-9_-]{43}$/);
  });

  it('stores the session on the device, so the refresh token really renews', async () => {
    const { refreshToken } = await NexxusApiSession.issue(app, device, USER);

    expect((await NexxusDevice.get('d1')).hasActiveSession()).toBe(true);
    expect(await NexxusDevice.rotateSession('d1', secretOf(refreshToken), 'next')).toBe('rotated');
  });

  it('defaults to an absolute 30-day deadline', async () => {
    const before = nowSeconds();

    await NexxusApiSession.issue(app, device, USER);

    expect(storedSession().expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(storedSession().expiresAt).toBeLessThanOrEqual(nowSeconds() + 30 * DAY);
  });

  it('uses the application\'s own refresh lifetime when it declares one', async () => {
    const weekLong = seedApp(makeAuthApp({ session: { refreshTokenExpiresIn: 7 * DAY } }));
    const before = nowSeconds();

    await NexxusApiSession.issue(weekLong, device, USER);

    expect(storedSession().expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(storedSession().expiresAt).toBeLessThanOrEqual(nowSeconds() + 7 * DAY);
  });

  it('mints the access token for the application\'s own lifetime', async () => {
    const shortLived = seedApp(makeAuthApp({ session: { jwtExpiresIn: 15 * 60 } }));
    const { token } = await NexxusApiSession.issue(shortLived, device, USER);
    const claims = NexxusToken.verify(shortLived, token);

    expect(claims.exp - claims.iat).toBe(15 * 60);
  });

  it('replaces the device\'s previous session, ending its refresh token', async () => {
    const first = await NexxusApiSession.issue(app, device, USER);
    const second = await NexxusApiSession.issue(app, device, USER);

    expect(secretOf(second.refreshToken)).not.toBe(secretOf(first.refreshToken));
    expect(await NexxusDevice.rotateSession('d1', secretOf(first.refreshToken), 'x')).toBe('invalid');
  });

  it('hands out nothing when the session cannot be stored', async () => {
    // Never saved, so there is no document to put a session on.
    const ghost = new NexxusDevice({ id: 'ghost', appId: 'app1', name: 'N', subscriptions: [] });

    await expect(NexxusApiSession.issue(app, ghost, USER)).rejects.toThrow(/Failed to start a session/);
  });
});

/** A stored user, as the database adapter hands it back. */
const storedUser = (overrides: Partial<INexxusUser> = {}): NexxusUser => new NexxusUser({
  id: 'u1', type: 'user', appId: 'app1', username: 'ann', password: null,
  authProviders: [ 'local' ], devices: [ 'd1' ], details: {}, userType: 'default', ...overrides,
} as INexxusUser);

describe('NexxusApiSession.refresh', () => {
  let redis: FakeRedis;
  let app: NexxusApplication;

  beforeEach(async () => {
    installApiStatics();
    redis = installFakeRedis();
    app = seedApp(makeAuthApp());
    dbState.getItemsResult = [ storedUser() ];

    await new NexxusDevice({ id: 'd1', appId: 'app1', userId: 'u1', name: 'Phone', subscriptions: [] }).save();
  });

  /** Issue a session on `d1` and return its refresh token — what sign-in hands a client. */
  const signIn = async (): Promise<string> =>
    (await NexxusApiSession.issue(app, await NexxusDevice.get('d1'), USER)).refreshToken;
  const storedSession = (): any => (redis.store.get(NexxusDevice.getKey('d1')) as { value: any }).value.session;

  it('exchanges a refresh token for the next pair', async () => {
    const first = await signIn();
    const next = await NexxusApiSession.refresh(app, first);

    expect(NexxusToken.verify(app, next.token)).toMatchObject({ appId: 'app1', deviceId: 'd1' });
    expect(next.refreshToken).toMatch(/^d1\.[A-Za-z0-9_-]{43}$/);
    expect(next.refreshToken).not.toBe(first);
    // The new token is the next link in the chain.
    await expect(NexxusApiSession.refresh(app, next.refreshToken)).resolves.toBeDefined();
  });

  it('re-reads the user, so the new access token carries the account as stored now', async () => {
    const refreshToken = await signIn();

    dbState.getItemsResult = [ storedUser({ username: 'ann.renamed', details: { nickname: 'annie' } }) ];

    const { token } = await NexxusApiSession.refresh(app, refreshToken);

    expect(NexxusToken.verify(app, token).user).toMatchObject({ username: 'ann.renamed', details: { nickname: 'annie' } });
    expect(dbState.getItemsCalls.at(-1)).toMatchObject({ ids: [ 'u1' ], type: 'user', appId: 'app1' });
  });

  it('keeps provider-owned $auth details out of the refreshed token', async () => {
    const refreshToken = await signIn();

    dbState.getItemsResult = [ storedUser({ details: { nickname: 'annie', $auth_google: { id: 'g-123' } } }) ];

    const { token } = await NexxusApiSession.refresh(app, refreshToken);

    expect(NexxusToken.verify(app, token).user!.details).toEqual({ nickname: 'annie' });
  });

  it('refuses, and ends the session, when the user no longer exists', async () => {
    const refreshToken = await signIn();

    dbState.getItemsResult = [];

    await expect(NexxusApiSession.refresh(app, refreshToken)).rejects.toThrow(InvalidRefreshTokenException);
    expect(storedSession()).toBeUndefined();
  });

  it('issues a device-only token for a device with no owner, without touching the database', async () => {
    const zeroAuth = seedApp(makeApp());

    await new NexxusDevice({ id: 'kiosk', appId: 'app1', name: 'Kiosk', subscriptions: [] }).save();

    const { refreshToken } = await NexxusApiSession.issue(zeroAuth, await NexxusDevice.get('kiosk'));
    const readsBefore = dbState.getItemsCalls.length;
    const { token } = await NexxusApiSession.refresh(zeroAuth, refreshToken);

    expect(NexxusToken.verify(zeroAuth, token).user).toBeUndefined();
    expect(dbState.getItemsCalls).toHaveLength(readsBefore);
  });

  it('refuses a replayed token, ends the session, and says so in the log', async () => {
    const original = await signIn();

    await NexxusApiSession.refresh(app, original);
    storedSession().rotatedAt -= 60;

    await expect(NexxusApiSession.refresh(app, original)).rejects.toThrow(InvalidRefreshTokenException);
    expect(storedSession()).toBeUndefined();
    expect(logger.has('warning', /Refresh token replayed/)).toBe(true);
  });

  it('refuses a token whose session has expired', async () => {
    const refreshToken = await signIn();

    storedSession().expiresAt = nowSeconds() - 1;

    await expect(NexxusApiSession.refresh(app, refreshToken)).rejects.toThrow(InvalidRefreshTokenException);
  });

  it('refuses a device that belongs to another application, and leaves its session alone', async () => {
    const refreshToken = await signIn();
    const before = { ...storedSession() };

    await expect(NexxusApiSession.refresh(seedApp(makeAuthApp({ id: 'app2' })), refreshToken))
      .rejects.toThrow(InvalidRefreshTokenException);
    expect(storedSession()).toEqual(before);
  });

  it('refuses malformed tokens and unknown devices alike', async () => {
    for (const bad of [ 'no-separator', '.secret-only', 'd1.', 'ghost.some-secret' ]) {
      await expect(NexxusApiSession.refresh(app, bad)).rejects.toThrow(InvalidRefreshTokenException);
    }
  });
});

describe('NexxusApiSession.revoke', () => {
  let redis: FakeRedis;
  let app: NexxusApplication;

  beforeEach(async () => {
    installApiStatics();
    redis = installFakeRedis();
    app = seedApp(makeAuthApp());

    await new NexxusDevice({ id: 'd1', appId: 'app1', userId: 'u1', name: 'Phone', subscriptions: [] }).save();
  });

  const signIn = async (): Promise<string> =>
    (await NexxusApiSession.issue(app, await NexxusDevice.get('d1'), USER)).refreshToken;
  const storedSession = (): any => (redis.store.get(NexxusDevice.getKey('d1')) as { value: any }).value.session;

  it('ends the session a matching token belongs to', async () => {
    const refreshToken = await signIn();

    await NexxusApiSession.revoke(app, refreshToken);

    expect(storedSession()).toBeUndefined();
    await expect(NexxusApiSession.refresh(app, refreshToken)).rejects.toThrow(InvalidRefreshTokenException);
  });

  it('is silent, and ends nothing, for a token the session does not recognise', async () => {
    await signIn();

    const before = { ...storedSession() };

    for (const bad of [ 'd1.not-the-secret', 'no-separator', 'ghost.some-secret' ]) {
      await expect(NexxusApiSession.revoke(app, bad)).resolves.toBeUndefined();
    }

    expect(storedSession()).toEqual(before);
  });

  it('is silent, and ends nothing, for another application\'s device', async () => {
    const refreshToken = await signIn();
    const before = { ...storedSession() };

    await expect(NexxusApiSession.revoke(seedApp(makeAuthApp({ id: 'app2' })), refreshToken)).resolves.toBeUndefined();
    expect(storedSession()).toEqual(before);
  });

  /**
   * The device's access token stays valid until it expires, so without this an
   * open socket would go on receiving until then. The message goes straight to
   * the queue of the node holding the socket.
   */
  it('tells the transport holding the device\'s live connection to drop it', async () => {
    await NexxusDevice.update('d1', { type: 'volatile', transport: 'websockets-transport_0', status: 'online' });

    await NexxusApiSession.revoke(app, await signIn());

    expect(mqState.published).toEqual([
      { queue: 'websockets-transport_0', message: { event: 'device_logout', deviceIds: [ 'd1' ] }, metadata: undefined },
    ]);
  });

  it('publishes nothing for a device that holds no live connection', async () => {
    // Never connected to a transport.
    await NexxusApiSession.revoke(app, await signIn());

    // Persistent: it has a transport, but no connection to drop.
    await NexxusDevice.update('d1', { type: 'persistent', transport: 'apns-transport' });
    await NexxusApiSession.revoke(app, await signIn());

    expect(mqState.published).toEqual([]);
  });

  it('publishes nothing when the token ends nothing', async () => {
    await NexxusDevice.update('d1', { type: 'volatile', transport: 'websockets-transport_0' });
    await signIn();

    await NexxusApiSession.revoke(app, 'd1.not-the-secret');

    expect(mqState.published).toEqual([]);
  });

  it('still ends the session when the transport cannot be told', async () => {
    await NexxusDevice.update('d1', { type: 'volatile', transport: 'websockets-transport_0' });

    const refreshToken = await signIn();

    mqState.publishImpl = () => { throw new Error('broker unreachable'); };

    await expect(NexxusApiSession.revoke(app, refreshToken)).resolves.toBeUndefined();
    expect(storedSession()).toBeUndefined();
    expect(logger.has('warning', /could not tell its transport to drop the connection/)).toBe(true);
  });
});
