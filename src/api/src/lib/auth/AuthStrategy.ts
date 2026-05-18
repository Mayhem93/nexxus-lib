import { NexxusApi, NexxusApiUser } from '../Api';
import { UserAuthenticationFailedException } from '../Exceptions';

import {
  NexxusUser,
  NexxusFilterQuery,
  INexxusUser
} from '@mayhem93/nexxus-core-lib';

import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcrypt';

export interface NexxusBaseAuthStrategyConfig {
  jwtSecret: string;
  jwtExpiresIn?: string;
  [key: string]: any;
}

export type NexxusAuthProviders = 'local' | 'google' | string;

export default abstract class NexxusAuthStrategy<T extends NexxusBaseAuthStrategyConfig = NexxusBaseAuthStrategyConfig> {
  abstract readonly name: string;
  abstract readonly requiresCallback: boolean;
  protected config: T = {} as T;
  protected static jwtSecret: string;
  protected static jwtExpiresIn: string;

  abstract handleAuth(req: Request, res: Response, next: NextFunction): void | Promise<void>;
  abstract handleCallback(req: Request, res: Response, next: NextFunction): void | Promise<void>;

  initializePassport(): void {
    this.config = NexxusApi.instance.getAuthProviderConfig<T>(this.name);

    const apiConfig = NexxusApi.instance.getConfig();

    NexxusAuthStrategy.jwtSecret = apiConfig.auth?.jwtSecret as string;
    NexxusAuthStrategy.jwtExpiresIn = apiConfig.auth?.jwtExpiresIn || '7d';
  }

  /**
   * Generate JWT token from user object
   */
  protected generateToken(user: NexxusApiUser): string {
    return jwt.sign(user, NexxusAuthStrategy.jwtSecret,
      {
        expiresIn: NexxusAuthStrategy.jwtExpiresIn as any,
        issuer: 'localhost',
        audience: user.appId
      }
    );
  }

  /**
   * Send success response with token
   */
  protected sendTokenResponse(res: Response, user: NexxusApiUser): void {
    const token = this.generateToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username
      }
    });
  }

  /**
   * Find user by username (email)
   */
  public async findUserByUsername(appId: string, username: string): Promise<NexxusUser | null> {
    const app = NexxusApi.getStoredApp(appId);
    const fq = new NexxusFilterQuery({ username }, NexxusUser.getModelSchema(app?.getUserDetailSchema()));

    const res = await NexxusApi.database.searchItems({
      appId,
      type: 'user',
      filter: fq
    });

    return res.length > 0 ? res[0] : null;
  }

  /**
   * Create new user
   * For local strategy: includes password hash
   * For OAuth: password is null
   */
  public async createUser(appId: string, data: {
    username: string;
    userType?: string;
    password?: string;
    authProviders: NexxusAuthProviders[];
    details?: Record<string, any>;
  }): Promise<NexxusUser> {
    const userData: INexxusUser = {
      type: 'user',
      appId,
      userType: data.userType || 'default',
      username: data.username,
      password: data.password ? NexxusAuthStrategy.hashPassword(data.password) : null,
      authProviders: data.authProviders,
      devices: [],
      details: data.details || {}
    };
    const user = new NexxusUser(userData);

    await NexxusApi.database.createItems([ user ]);

    return user;
  }

  /**
   * Find user by username, create if doesn't exist (for OAuth)
   */
  protected async findOrCreateUser(appId: string, data: {
    username: string;
    userType?: string;
    authProvider: NexxusAuthProviders;
    details?: Record<string, any>;
  }): Promise<[NexxusUser, 'found' | 'created']> {
    let user = await this.findUserByUsername(appId, data.username);
    const app = NexxusApi.getStoredApp(appId);
    let result: [NexxusUser, 'found' | 'created'];

    if (!user) {
      user = await this.createUser(appId, {
        userType: data.userType,
        authProviders: [data.authProvider],
        username: data.username,
        details: data.details
      });

      result = [user, 'created'];
    } else if (!user.getData().authProviders.includes(data.authProvider) && app?.getData().allowMultipleLogin === false) {
      throw new UserAuthenticationFailedException(
        `User not registered for ${data.authProvider} authentication and multiple login is disabled`
      )
    } else {
      result = [user, 'found'];
    }

    return result;
  }

  protected static convertToApiUser(user: NexxusUser): NexxusApiUser {
    const data = user.getData();

    return {
      id: data.id!,
      username: data.username,
      userType: data.userType,
      authProviders: data.authProviders,
      details: data.details,
      appId: data.appId
    };
  }

  public static hashPassword(password: string): string {
    return bcrypt.hashSync(password, 10);
  }

  protected static verifyPassword(password: string, hash: string): boolean {
    return bcrypt.compareSync(password, hash);
  }
}
