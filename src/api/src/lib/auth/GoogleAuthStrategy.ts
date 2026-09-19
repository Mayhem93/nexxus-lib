import NexxusAuthStrategy, { NexxusBaseAuthStrategyConfig } from './AuthStrategy';
import {
  NexxusApi,
  NexxusApiUser,
  NexxusApiRequest,
  NexxusApiResponse
} from '../Api';
import { UserAuthenticationFailedException } from '../Exceptions';

import { NexxusJsonPatch, NexxusUser, type NexxusUserDetailSchema } from '@mayhem93/nexxus-core-lib';
import { NexxusAuthNonce } from '@mayhem93/nexxus-redis';

import type { NextFunction, Request, Response } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile } from 'passport-google-oauth20';
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

  /**
   * What Google tells us about a user, stored at `details.$auth_google`.
   *
   * All optional: a profile may legitimately lack a display name, and an
   * account created before this strategy was enabled has no subtree at all —
   * absence is how "this user has never signed in with Google" is expressed.
   */
  static readonly userDetailSchema = {
    name: { type: 'string', required: false },
    id:   { type: 'string', required: false }
  } as const satisfies NexxusUserDetailSchema;

  initializePassport(): void {
    passport.use(this.passportName, new GoogleStrategy(
      {
        clientID: this.config.clientID,
        clientSecret: this.config.clientSecret,
        callbackURL: this.config.callbackURL,
        scope: ['profile', 'email'],
        passReqToCallback: true
      },
      (req, _accessToken, _refreshToken, profile, done) => {
        void this.verifyProfile(req as NexxusApiRequest, profile, done);
      }
    ));
  }

  /**
   * Turn a verified Google profile into a Nexxus user.
   *
   * A named method rather than a closure passed to the strategy constructor
   * because this is where the account-matching rules live — including the
   * verified-email check, which is the difference between linking an account
   * and handing one over. Reaching it through the real `GoogleStrategy` would
   * mean an outbound OAuth round trip.
   */
  protected async verifyProfile(
    req: NexxusApiRequest,
    profile: Profile,
    done: (err: unknown, user?: NexxusApiUser | false) => void
  ): Promise<void> {
    try {
      // Set by handleCallback AFTER the state signature was verified and its
      // nonce redeemed. Never re-parse req.query.state here — that's the
      // attacker-controlled copy, and `userType` decides the ACL role the
      // account is created with.
      const authState = req.authState;

      if (!authState) {
        return done(new Error('Google callback reached the verify step with no verified state'));
      }

      const { appId, userType } = authState;
      const emailEntry = profile.emails?.[0];
      const email = emailEntry?.value;

      if (!email) {
        return done(new Error('No email found in Google profile'));
      }

      // Accounts are matched by email, so an UNVERIFIED one is an account
      // takeover: register at the provider with a victim's address and this
      // links straight into their existing account, no password needed.
      //
      // Fails CLOSED — anything short of an affirmative "verified" is refused,
      // including the claim being absent. Google always sends it, so in
      // practice this never fires; it's here so the rule is enforced by our
      // code rather than by a provider's good behaviour.
      //
      // Compared against the string too: the typing says boolean, but OAuth
      // providers have a long history of sending "true"/"false", and a
      // truthiness check on the string "false" would pass.
      const verified = emailEntry.verified as boolean | string | undefined;

      if (verified !== true && verified !== 'true') {
        return done(new UserAuthenticationFailedException('Google account email is not verified'));
      }

      const [ user, status ] = await this.findOrCreateUser({
        username: email,
        userType,
        authProvider: 'google',
        authDetails: {
          name: profile.displayName,
          id: profile.id
        }
      });

      if (status === 'found' && !user.getData().authProviders.includes('google')) {
        NexxusApi.logger.debug(`Linking Google to existing user`, { user: user.getData() }, 'GoogleAuthStrategy');

        const metadata = { appId, id: user.getData().id!, type: 'user' };
        const providersPatch = new NexxusJsonPatch({
          op: 'append', path: [ 'authProviders' ], value: [ 'google' ], metadata
        });
        const updatedAtPatch = new NexxusJsonPatch({
          op: 'replace', path: [ 'updatedAt' ], value: [ new Date() ], metadata
        });
        const userSchema = NexxusUser.getModelSchema(this.app.getUserDetailSchema(userType));

        providersPatch.validate(userSchema);
        updatedAtPatch.validate(userSchema);

        await NexxusApi.database.updateItems([ providersPatch, updatedAtPatch ]);

        // Mirror it so the token this login mints says the account is linked —
        // the patch is applied asynchronously by the writer, and re-reading
        // just to learn what we already know would be a wasted round trip.
        user.getData().authProviders.push('google');
      }

      return done(null, NexxusAuthStrategy.convertToApiUser(user));
    } catch (error) {
      return done(error);
    }
  }

  async handleAuth(req: NexxusApiRequest, res: NexxusApiResponse, next: NextFunction): Promise<void> {
    const appId = req.headers['nxx-app-id'] as string;
    const app = NexxusApi.getStoredApp(appId);
    const userType = req.body.userType || 'default';

    if (!app?.getUserDetailSchema(userType)) {
      return next(new UserAuthenticationFailedException(`User type "${userType}" not found in application "${appId}"`));
    }

    // `state` carries the appId and the userType the callback will create the
    // account with, so it has to come back exactly as it left: HMAC-signed
    // against this app's derived key so it can't be edited, and carrying a
    // single-use nonce so it can't be replayed or forged by a third party.
    // Without both, a caller could hand themselves any userType the app
    // declares — and userType selects the ACL role.
    const nonce = await NexxusAuthNonce.issue(appId);
    const state = this.signState({ appId, userType, nonce, deviceId: req.body?.device?.id });

    // Initiate Google OAuth flow (redirects browser to Google)
    passport.authenticate(this.passportName, {
      session: false,
      scope: ['profile', 'email'],
      state
    })(req, res, next);
  }

  async handleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
    const rawState = req.query.state as string | undefined;

    if (!rawState) {
      return next(new UserAuthenticationFailedException('Missing state parameter'));
    }

    const payload = this.verifyState(rawState);

    if (!payload) {
      return next(new UserAuthenticationFailedException('Invalid state parameter'));
    }

    // Redeem before doing anything else. GETDEL makes this one-shot, so a
    // replayed callback — or a second concurrent one — fails here.
    const redeemed = await NexxusAuthNonce.consume(payload.appId, payload.nonce);

    if (redeemed === null) {
      return next(new UserAuthenticationFailedException('Expired or already used state parameter'));
    }

    // Hand the verify callback the values we just proved, so it never has to
    // look at req.query.state.
    (req as NexxusApiRequest).authState = { appId: payload.appId, userType: payload.userType };

    // Handle Google's callback (browser was redirected here by Google)
    passport.authenticate(this.passportName, { session: false }, (err: any, user: NexxusApiUser, info: any) => {
      if (err) {
        return next(err);
      }

      if (!user) {
        return res.status(401).json({ error: info?.message || 'Authentication failed' });
      }

      // Device hint comes from the signed state — a redirect has no body.
      void this.sendTokenResponse(res, user, { id: payload.deviceId }).catch(next);
    })(req, res, next);
  }
}
