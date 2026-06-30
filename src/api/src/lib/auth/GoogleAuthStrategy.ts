import NexxusAuthStrategy, { NexxusBaseAuthStrategyConfig } from './AuthStrategy';
import {
  NexxusApi,
  NexxusApiUser,
  NexxusApiRequest,
  NexxusApiResponse
} from '../Api';
import { UserAuthenticationFailedException } from '../Exceptions';

import { NexxusJsonPatch, NexxusUser } from '@mayhem93/nexxus-core-lib';

import type { NextFunction, Request, Response } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import * as path from 'node:path';

export interface NexxusGoogleAuthConfig extends NexxusBaseAuthStrategyConfig {
  clientID: string;
  clientSecret: string;
  callbackURL: string; // e.g., "http://localhost:3000/auth/google/callback"
}

export default class NexxusGoogleAuthStrategy extends NexxusAuthStrategy<NexxusGoogleAuthConfig> {
  readonly name = 'google';
  static readonly requiresCallback = true;
  protected static schemaPath: string = path.join(__dirname, '../../../src/schemas/google-auth-strategy.schema.json');

  initializePassport(): void {
    passport.use(this.passportName, new GoogleStrategy(
      {
        clientID: this.config.clientID,
        clientSecret: this.config.clientSecret,
        callbackURL: this.config.callbackURL,
        scope: ['profile', 'email'],
        passReqToCallback: true
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const [appId, userType] = (req.query.state as string).split('|');
          const email = profile.emails?.[0]?.value;
          const app = NexxusApi.getStoredApp(appId);

          if (!email) {
            return done(new Error('No email found in Google profile'));
          }

          // Find or create user
          const [user, status] = await this.findOrCreateUser(appId, {
            username: email,
            userType,
            authProvider: 'google',
            details: {
              name: profile.displayName,
              googleId: profile.id
            }
          });

          if (status === 'found') {
            const hasGoogleAuth = user.getData().authProviders.includes('google');

            if (hasGoogleAuth) {
              return done(null, NexxusAuthStrategy.convertToApiUser(user));
            }

            NexxusApi.logger.debug(`Google auth status: ${status}`, { user: user.getData() }, 'GoogleAuthStrategy');

            // update user with additional auth provider
            const patch = new NexxusJsonPatch({
              op: 'append',
              path: ['authProviders'],
              value: ['google'],
              metadata: {
                appId,
                id: user.getData().id!,
                type: 'user'
              }
            });

            const updatedAtPatch = new NexxusJsonPatch({
              op: 'replace',
              path: ['updatedAt'],
              value: [new Date()],
              metadata: {
                appId,
                id: user.getData().id!,
                type: 'user'
              }
            });

            const userSchema = NexxusUser.getModelSchema(app?.getUserDetailSchema(userType));

            patch.validate(userSchema);
            updatedAtPatch.validate(userSchema);

            await NexxusApi.database.updateItems([patch, updatedAtPatch]);
          }

          return done(null, NexxusAuthStrategy.convertToApiUser(user));
        } catch (error) {
          return done(error);
        }
      }
    ));
  }

  async handleAuth(req: NexxusApiRequest, res: NexxusApiResponse, next: NextFunction): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId);
    const userType = req.body.userType || 'default';

    if (!app?.getUserDetailSchema(userType)) {
      return next(new UserAuthenticationFailedException(`User type "${userType}" not found in application "${appId}"`));
    }

    // Initiate Google OAuth flow (redirects browser to Google)
    passport.authenticate(this.passportName, {
      session: false,
      scope: ['profile', 'email'],
      state: `${appId}|${userType}` // Pass appId and userType via state
    })(req, res, next);
  }

  async handleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Handle Google's callback (browser was redirected here by Google)
    passport.authenticate(this.passportName, { session: false }, (err: any, user: NexxusApiUser, info: any) => {
      if (err) {
        return next(err);
      }

      // NexxusApi.logger.debug(`Google authentication callback invoked: ${JSON.stringify(user)}`, 'GoogleAuthStrategy');

      if (!user) {
        return res.status(401).json({ error: info?.message || 'Authentication failed' });
      }

      this.sendTokenResponse(res, user);
    })(req, res);
  }
}
