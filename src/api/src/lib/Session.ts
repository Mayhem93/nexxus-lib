import { NexxusApi, type NexxusApiUser } from './Api';
import { NexxusAuthStrategy } from './auth';
import { InvalidRefreshTokenException } from './Exceptions';

import { NexxusToken, type NexxusApplication } from '@mayhem93/nexxus-core-lib';
import { NexxusDevice, RedisKeyNotFoundException } from '@mayhem93/nexxus-redis';

import { randomBytes } from 'node:crypto';

const LOG_LABEL = 'NxxApiSession';

/** What a client receives whenever a session is issued or refreshed. */
export type NexxusApiSessionTokens = {
  /** Short-lived access token (JWT) naming the device, and the user when there is one. */
  token: string;
  /** Long-lived, revocable credential that obtains the next access token: `<deviceId>.<secret>`. */
  refreshToken: string;
};

/**
 * Issuing, refreshing and ending sessions — an access token, and the refresh
 * token that renews it. The refresh token's format is written and read here and
 * nowhere else.
 *
 * Deliberately NOT on `NexxusAuthStrategy`. Applications without authentication
 * have sessions too — `/device/register` is how a zero-auth device gets one —
 * and they have no strategy. The same reasoning put `signingSecret` on the
 * application rather than under `auth`: every application issues tokens.
 */
export class NexxusApiSession {
  /**
   * Start a session on `device`: store a new refresh secret on it, and mint the
   * access token that names it. Both lifetimes are the application's
   * (`session.jwtExpiresIn`, `session.refreshTokenExpiresIn`); the refresh one is
   * absolute, so the device has to sign in again once it passes.
   *
   * Replaces any session the device already had, so a sign-in on a reused device
   * ends the refresh token the previous sign-in handed out.
   *
   * `user` is absent on an application without authentication; the tokens then
   * carry the device alone.
   */
  public static async issue(
    app: NexxusApplication,
    device: NexxusDevice,
    user?: NexxusApiUser
  ): Promise<NexxusApiSessionTokens> {
    const appId = app.getData().id as string;
    const deviceId = device.getValue().id;
    const secret = NexxusApiSession.generateSecret();

    // Stored before the access token is minted: if the write fails, nothing is
    // handed out.
    await NexxusDevice.setSession(deviceId, secret, NexxusApiSession.nowSeconds() + app.getRefreshTokenExpiresIn());

    return {
      token: NexxusToken.issue(app, { appId, deviceId, user }),
      refreshToken: NexxusApiSession.format(deviceId, secret)
    };
  }

  /**
   * Exchange a refresh token for the next pair — the refresh.
   *
   * The credential is checked first, against Redis alone; only then is the user
   * re-read from the database, so an unauthenticated caller can't make this
   * spend a database read. That re-read is what keeps claims current: the new
   * access token carries the user as stored now, not as at sign-in, and a user
   * who no longer exists can't refresh at all.
   *
   * Every refusal is the same `InvalidRefreshTokenException`. To a client they
   * all mean "sign in again", and saying which — expired, replayed, another
   * application's device — would only inform someone probing.
   */
  public static async refresh(app: NexxusApplication, refreshToken: string): Promise<NexxusApiSessionTokens> {
    const appId = app.getData().id as string;
    const parsed = NexxusApiSession.parse(refreshToken);
    const device = parsed ? await NexxusApiSession.loadDevice(parsed.deviceId, appId) : null;

    if (!parsed || !device) {
      throw new InvalidRefreshTokenException('Invalid refresh token');
    }

    const { deviceId, secret } = parsed;
    const nextSecret = NexxusApiSession.generateSecret();
    const outcome = await NexxusDevice.rotateSession(deviceId, secret, nextSecret);

    if (outcome !== 'rotated') {
      if (outcome === 'replayed') {
        // Either the client or someone holding a copy of its token had already
        // moved past this one. The session is over for both; worth knowing.
        NexxusApi.logger.warn(
          `Refresh token replayed — ended the session of device "${deviceId}"`,
          { appId, deviceId },
          LOG_LABEL
        );
      }

      throw new InvalidRefreshTokenException('Invalid refresh token');
    }

    const userId = device.getValue().userId;
    let user: NexxusApiUser | undefined;

    if (userId) {
      const [ stored ] = await NexxusApi.database.getItems({ ids: [ userId ], type: 'user', appId });

      if (!stored) {
        // The account is gone, so its devices can't go on minting tokens for it.
        await NexxusDevice.clearSession(deviceId);

        throw new InvalidRefreshTokenException('Invalid refresh token');
      }

      user = NexxusAuthStrategy.convertToApiUser(stored);
    }

    return {
      token: NexxusToken.issue(app, { appId, deviceId, user }),
      refreshToken: NexxusApiSession.format(deviceId, nextSecret)
    };
  }

  /**
   * End the session a refresh token belongs to — logout.
   *
   * Silent by design, as OAuth token revocation (RFC 7009) is: a token that is
   * malformed, unknown, another application's or already revoked gives the same
   * result as one that ended a session, so the endpoint can't be used to test
   * which tokens are live. Only a token the session recognises ends anything.
   *
   * A session that does end also has its live connection dropped, if the device
   * holds one: its access token stays valid until it expires, and without this
   * an open socket would go on receiving until then.
   */
  public static async revoke(app: NexxusApplication, refreshToken: string): Promise<void> {
    const appId = app.getData().id as string;
    const parsed = NexxusApiSession.parse(refreshToken);
    const device = parsed ? await NexxusApiSession.loadDevice(parsed.deviceId, appId) : null;

    if (!parsed || !device) {
      return;
    }

    if (await NexxusDevice.revokeSession(parsed.deviceId, parsed.secret) !== 'revoked') {
      return;
    }

    NexxusApi.logger.debug(`Ended the session of device "${parsed.deviceId}"`, { appId }, LOG_LABEL);

    await NexxusApiSession.dropLiveConnection(device);
  }

  /**
   * Tell the transport worker holding `device`'s live connection to drop it.
   *
   * Published straight to the queue named in the device's `transport` — that is
   * the node with the socket. Only volatile devices have one; a device with no
   * `transport` isn't connected, and a persistent one holds no connection to
   * drop.
   *
   * A failure here doesn't undo the logout: the session is already ended, and the
   * connection still can't outlive its access token. So it is logged, not thrown.
   */
  private static async dropLiveConnection(device: NexxusDevice): Promise<void> {
    const { id, type, transport } = device.getValue();

    if (type !== 'volatile' || !transport) {
      return;
    }

    try {
      await NexxusApi.messageQueue.publishMessage(transport, { event: 'device_logout', deviceIds: [ id ] });
    } catch (e) {
      NexxusApi.logger.warn(
        `Ended the session of device "${id}", but could not tell its transport to drop the connection: ${(e as Error).message}`,
        { deviceId: id, transport },
        LOG_LABEL
      );
    }
  }

  /**
   * The device a refresh token names, if it exists AND belongs to `appId`;
   * otherwise `null`. A device of another application is treated exactly like a
   * missing one — the token names nothing this application issued.
   */
  private static async loadDevice(deviceId: string, appId: string): Promise<NexxusDevice | null> {
    let device: NexxusDevice;

    try {
      device = await NexxusDevice.get(deviceId);
    } catch (e) {
      if (e instanceof RedisKeyNotFoundException) {
        return null;
      }

      throw e;
    }

    return device.getValue().appId === appId ? device : null;
  }

  /** 256 random bits, base64url — an alphabet with no '.', which `parse` relies on. */
  private static generateSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  private static format(deviceId: string, secret: string): string {
    return `${deviceId}.${secret}`;
  }

  /**
   * Split `<deviceId>.<secret>`, or `null` when it isn't that shape. Splits on the
   * LAST '.', since the secret can't contain one.
   */
  private static parse(refreshToken: string): { deviceId: string; secret: string } | null {
    const dot = refreshToken.lastIndexOf('.');

    if (dot <= 0 || dot === refreshToken.length - 1) {
      return null;
    }

    return { deviceId: refreshToken.slice(0, dot), secret: refreshToken.slice(dot + 1) };
  }

  private static nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }
}
