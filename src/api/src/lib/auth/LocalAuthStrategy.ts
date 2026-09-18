import NexxusAuthStrategy from './AuthStrategy';
import { NexxusApiUser, NexxusApi } from '../Api';
import { UserAuthenticationFailedException } from '../Exceptions';

import passport from 'passport';
import { Strategy as PassportLocalStrategy } from 'passport-local';
import type { NextFunction, Request, Response } from 'express';
import * as path from 'node:path';

/**
 * Passport's verify callback. `info` carries the failure reason on a rejection
 * — passport types it as its own `IVerifyOptions`, but we hand it an exception,
 * which `handleAuth` reads the message off.
 */
export type LocalVerifyDone = (err: unknown, user?: NexxusApiUser | false, info?: unknown) => void;

export default class NexxusLocalAuthStrategy extends NexxusAuthStrategy {
  readonly name = 'local';
  static readonly requiresCallback = false;
  protected static schemaPath: string = path.join(__dirname, '../../../src/schemas/local-auth-strategy.schema.json');

  initializePassport(): void {
    // No `passReqToCallback`: the verify step needs nothing from the request
    // beyond the credentials themselves — the application comes from this
    // instance, and the device hint is read separately in `handleAuth`.
    passport.use(this.passportName, new PassportLocalStrategy(
      {
        usernameField: 'username',
        passwordField: 'password'
      },
      (username, password, done) => {
        void this.verifyCredentials(username, password, done as LocalVerifyDone);
      }
    ));
  }

  /**
   * Check a username and password against this application's user records.
   *
   * A named method rather than a closure passed to the strategy constructor so
   * the branches that matter — an unknown user, an account with no password,
   * and a wrong password — can be exercised directly. Reaching them through a
   * route would mean asserting on HTTP responses for what is really one
   * function's decision.
   *
   * All three failures report the SAME message. Distinguishing "no such user"
   * from "wrong password" would turn the login endpoint into an account
   * enumeration oracle.
   */
  protected async verifyCredentials(
    username: string,
    password: string,
    done: (err: unknown, user?: NexxusApiUser | false, info?: unknown) => void
  ): Promise<void> {
    try {
      const user = await this.findUserByUsername(username);

      if (!user) {
        return done(null, false, new UserAuthenticationFailedException('Invalid credentials'));
      }

      // A null hash means the account has no local credentials at all — it was
      // created through an OAuth provider. Without this check, `verifyPassword`
      // would be handed a null hash.
      const passwordHash = user.getData().password;

      if (!passwordHash || !await NexxusLocalAuthStrategy.verifyPassword(password, passwordHash)) {
        return done(null, false, new UserAuthenticationFailedException('Invalid credentials'));
      }

      return done(null, NexxusAuthStrategy.convertToApiUser(user));
    } catch (error) {
      return done(error);
    }
  }

  async handleAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    passport.authenticate(this.passportName, { session: false }, (err: any, user?: NexxusApiUser, info?: any) => {
      if (err) {
        return next(err);
      }

      if (!user) {
        NexxusApi.logger.debug(`Local authentication failed: ${info?.message}`, 'AuthStrategy');

        if (info?.message === 'Missing credentials') {
          return next(new UserAuthenticationFailedException('Username and password are required'));
        }

        return next(new UserAuthenticationFailedException('Authentication failed'));
      }

      // The client passes back the device id it stored at its last login, so a
      // returning user reuses their device instead of accruing a new one.
      void this.sendTokenResponse(res, user, req.body?.device).catch(next);
    })(req, res, next);
  }

  handleCallback(req: Request, res: Response): void {}
}
