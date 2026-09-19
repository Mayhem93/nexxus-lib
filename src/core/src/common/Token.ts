import { TokenExpiredException, InvalidTokenException } from '../lib/Exceptions';

import jwt from 'jsonwebtoken';

// Type-only: erased at compile time, so these never become a runtime import
// cycle with the model modules.
import type { NexxusApplication } from '../models/Application';
import type { INexxusUser } from '../models/User';

/**
 * The principal carried by a token from an application with authentication.
 *
 * Note what is NOT here: `iat`, `exp`, `aud` and `iss`. Those are registered
 * claims and they sit at the token's root, not inside `user` — a distinction
 * worth keeping visible, because this object is handed to clients verbatim by
 * `/user/me`.
 */
export type NexxusTokenUser =
  & Pick<INexxusUser, 'username' | 'userType' | 'authProviders' | 'details' | 'appId'>
  & { id: string };

/**
 * What a caller must supply to mint a token.
 *
 * `deviceId` is required so no issue site can forget to bind a token to a
 * device; `user` is optional because an application without authentication has
 * no principal to name.
 */
export type NexxusTokenMint = {
  appId: string;
  deviceId: string;
  user?: NexxusTokenUser;
};

/** Claims `NexxusToken.issue` sets itself. Callers must not supply these. */
export type NexxusRegisteredClaims = {
  iat: number;
  exp: number;
  aud: string;
  iss: string;
};

/** A token from an application with no authentication: a device and nothing more. */
export type NexxusDeviceClaims = {
  appId: string;
  deviceId: string;
  user?: undefined;
};

/** A token from an application with authentication: a device AND a principal. */
export type NexxusUserClaims = {
  appId: string;
  deviceId: string;
  user: NexxusTokenUser;
};

/**
 * What verification hands back.
 *
 * A discriminated union with no tag field — `user` presence is the discriminant,
 * which is why the device variant declares `user?: undefined` rather than
 * omitting it. `if (claims.user)` narrows, and no extra byte goes into every
 * token to say what its shape already says.
 */
export type NexxusVerifiedClaims = (NexxusDeviceClaims | NexxusUserClaims) & NexxusRegisteredClaims;

/**
 * Issuing and verifying the tokens an application hands out.
 *
 * This lives in core rather than in the API because it has two consumers in
 * different packages: the API issues and verifies, and the transport workers
 * verify (a device presents its token when registering with a transport). Their
 * only shared ancestor is this package, and a security-critical verify is the
 * last thing that should exist in two copies.
 *
 * Everything is scoped to a `NexxusApplication` because the signing key is
 * per-application — passing the app rather than a loose secret means the key,
 * the expiry policy and the audience can never drift apart at a call site.
 */
export class NexxusToken {
  /** Token lifetime used when the application doesn't declare one. */
  private static readonly DEFAULT_EXPIRES_IN = '7d';

  private static readonly ISSUER = 'nexxus';

  /**
   * Sign `claims` with the application's key.
   *
   * `aud` is taken from the application rather than from the claims, so a token
   * is always stamped with the app that actually issued it.
   */
  public static issue(app: NexxusApplication, claims: NexxusTokenMint): string {
    const data = app.getData();

    return jwt.sign(claims, app.getSigningSecret(), {
      expiresIn: (data.auth?.jwtExpiresIn ?? NexxusToken.DEFAULT_EXPIRES_IN) as jwt.SignOptions['expiresIn'],
      issuer: NexxusToken.ISSUER,
      audience: data.id as string,
    });
  }

  /**
   * Verify a token against the application's key and return its claims.
   *
   * Throws `TokenExpiredException` or `InvalidTokenException` — never a raw
   * jsonwebtoken error — so callers in every package map the same two cases
   * instead of each switching on library-specific error names.
   *
   * `audience` is checked as well as the signature. Strictly that's redundant
   * while keys are per-application, but it costs nothing and it catches the one
   * realistic misconfiguration it protects against: the same secret pasted into
   * two application documents.
   *
   * The returned type is EARNED, not asserted. A signature proves a token
   * wasn't edited; it proves nothing about what's inside one. So the claims are
   * shape-checked here, once, and every consumer can then rely on an appId and
   * a deviceId being present instead of re-checking. Validation stays shallow
   * on purpose: whether `user.userType` is a type this application declares is
   * application policy, not core's business.
   */
  public static verify(app: NexxusApplication, token: string): NexxusVerifiedClaims {
    let claims: unknown;

    try {
      claims = jwt.verify(token, app.getSigningSecret(), {
        audience: app.getData().id as string,
      });
    } catch (e) {
      if ((e as Error).name === 'TokenExpiredError') {
        throw new TokenExpiredException('Token has expired');
      }

      throw new InvalidTokenException(`Invalid token: ${(e as Error).message}`);
    }

    if (!claims || typeof claims !== 'object') {
      throw new InvalidTokenException('Token payload is not an object');
    }

    const { appId, deviceId, user } = claims as Record<string, unknown>;

    // Emptiness is checked as well as the type: an empty string is a string,
    // and letting one through would hand every consumer a `deviceId` that
    // satisfies the type but names nothing — a Redis lookup for "", or a
    // device-required route rejecting a token that verified cleanly.
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new InvalidTokenException('Token does not name an application');
    }

    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new InvalidTokenException('Token carries no device');
    }

    if (user !== undefined && (typeof user !== 'object' || user === null)) {
      throw new InvalidTokenException('Token carries a malformed user');
    }

    return claims as NexxusVerifiedClaims;
  }

  /**
   * Read the `appId` claim WITHOUT verifying the token, or `null` if it isn't
   * there to read.
   *
   * Needed because verification requires the application's key, and finding the
   * application is exactly what the caller is trying to do — a transport worker
   * receives a token from a socket with no other context. So this only ever
   * selects which key to verify against: a forged `appId` selects a different
   * key and `verify` then rejects the signature.
   *
   * Never treat anything this returns as trusted on its own.
   */
  public static peekAppId(token: string): string | null {
    if (typeof token !== 'string') {
      return null;
    }

    const decoded = jwt.decode(token);

    if (!decoded || typeof decoded !== 'object') {
      return null;
    }

    const appId = (decoded as Record<string, unknown>).appId;

    return typeof appId === 'string' ? appId : null;
  }
}
