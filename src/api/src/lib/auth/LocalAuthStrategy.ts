import NexxusAuthStrategy from './AuthStrategy';
import { NexxusApiUser, NexxusApi } from '../Api';
import { UserAuthenticationFailedException } from '../Exceptions';

import passport from 'passport';
import { Strategy as PassportLocalStrategy } from 'passport-local';
import type { NextFunction, Request, Response } from 'express';
import * as path from 'node:path';

export default class NexxusLocalAuthStrategy extends NexxusAuthStrategy {
  readonly name = 'local';
  static readonly requiresCallback = false;
  protected static schemaPath: string = path.join(__dirname, '../../../src/schemas/local-auth-strategy.schema.json');

  initializePassport(): void {
    passport.use(this.passportName, new PassportLocalStrategy(
      {
        usernameField: 'username',
        passwordField: 'password',
        passReqToCallback: true
      },
      async (req, username, password, done) => {
        try {
          const appId = req.headers['nxx-app-id'] as string;
          const user = await this.findUserByUsername(appId, username);

          if (!user) {
            return done(null, false, new UserAuthenticationFailedException('Invalid credentials'));
          }

          const passwordHash = user.getData().password;

          // Verify password
          if (!passwordHash || !NexxusLocalAuthStrategy.verifyPassword(password, passwordHash)) {
            return done(null, false, new UserAuthenticationFailedException('Invalid credentials'));
          }

          return done(null, NexxusAuthStrategy.convertToApiUser(user));
        } catch (error) {
          return done(error);
        }
      }
    ));
  }

  async handleAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    passport.authenticate(this.passportName, { session: false }, (err: any, user?: NexxusApiUser, info?: any) => {
      if (err) {
        return next(err);
      }

      if (!user) {
        NexxusApi.logger.debug(`Local authentication failed: ${info.message}`, 'AuthStrategy');

        if (info.message === 'Missing credentials') {
          return next(new UserAuthenticationFailedException('Username and password are required'));
        }

        return next(new UserAuthenticationFailedException('Authentication failed'));
      }

      this.sendTokenResponse(res, user);
    })(req, res);
  }

  handleCallback(req: Request, res: Response): void {}
}
