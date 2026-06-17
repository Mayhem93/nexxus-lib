import { NexxusApi, NexxusApiUser } from '../Api';

import {
  NexxusUser,
  NexxusFilterQuery,
  INexxusUser
} from '@mayhem93/nexxus-core-lib';

import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import Ajv, { ValidateFunction } from 'ajv';
import type { JSONSchema7 } from 'json-schema';
import * as fs from 'node:fs';

export interface NexxusBaseAuthStrategyConfig {
  [key: string]: unknown;
}

export type NexxusAuthProviders = 'local' | 'google' | string;

export default abstract class NexxusAuthStrategy<T extends NexxusBaseAuthStrategyConfig = NexxusBaseAuthStrategyConfig> {
  abstract readonly name: string;
  /**
   * Whether this strategy needs a `/auth/<name>/callback` route registered
   * (i.e. OAuth-style flows). Class-level metadata — same for every instance
   * of a subclass — so it's static. Defaults to `false`; OAuth strategies
   * should `static readonly requiresCallback = true`. (TS doesn't support
   * abstract static, so the convention is documented rather than enforced.)
   */
  static requiresCallback: boolean = false;
  protected config: T;
  /** The Application this strategy instance belongs to. Set in the constructor. */
  protected appId: string;
  /** JWT signing secret for this Application (from `app.auth.jwtSecret`). */
  protected jwtSecret: string;
  /** JWT expiry for this Application (from `app.auth.jwtExpiresIn`, defaults to 7d). */
  protected jwtExpiresIn: string;

  /**
   * Path to the JSON Schema that validates this strategy's per-application
   * config. Subclasses MUST override (e.g. `protected static schemaPath =
   * path.join(__dirname, '../../src/schemas/<name>-auth-strategy.schema.json')`).
   *
   * The schema is loaded and AJV-compiled lazily on first construction of
   * a subclass — every strategy instance of the same subclass shares the
   * compiled validator (via `compiledValidators` keyed by class name).
   */
  protected static schemaPath: string;
  private static compiledValidators: Map<string, ValidateFunction> = new Map();

  abstract handleAuth(req: Request, res: Response, next: NextFunction): void | Promise<void>;
  abstract handleCallback(req: Request, res: Response, next: NextFunction): void | Promise<void>;

  constructor(config: T, appId: string, jwtSecret: string, jwtExpiresIn?: string) {
    NexxusAuthStrategy.validateConfig(this.constructor as typeof NexxusAuthStrategy, config);

    this.config = config;
    this.appId = appId;
    this.jwtSecret = jwtSecret;
    this.jwtExpiresIn = jwtExpiresIn ?? '7d';
  }

  /**
   * The name this strategy is registered under in the global Passport singleton.
   * Composite of strategy name and appId so each tenant can have its own
   * configured Passport strategy (necessary for OAuth providers whose config
   * — clientID/clientSecret — varies per app).
   *
   * Lazy because `this.name` is a subclass readonly field; it isn't set until
   * after the base constructor returns.
   */
  public get passportName(): string {
    return `${this.name}:${this.appId}`;
  }

  /**
   * Compiles the subclass's schema (cached, once per class) and validates
   * the given config. Throws with a flat list of AJV errors if invalid.
   * Called from the constructor — subclasses don't have to wire anything.
   */
  protected static validateConfig(Ctor: typeof NexxusAuthStrategy, config: unknown): void {
    const cacheKey = Ctor.name;
    let validator = NexxusAuthStrategy.compiledValidators.get(cacheKey);

    if (!validator) {
      if (!Ctor.schemaPath) {
        throw new Error(`Auth strategy "${cacheKey}" must declare a static schemaPath`);
      }

      const schema: JSONSchema7 = JSON.parse(fs.readFileSync(Ctor.schemaPath, 'utf-8'));
      const ajv = new Ajv({ useDefaults: true });

      validator = ajv.compile(schema);
      NexxusAuthStrategy.compiledValidators.set(cacheKey, validator);
    }

    if (!validator(config)) {
      const formatted = (validator.errors ?? [])
        .map(e => `${e.instancePath || '#root'}: ${e.message}`)
        .join('; ');

      throw new Error(`Invalid config for auth strategy "${cacheKey}": ${formatted}`);
    }
  }

  /**
   * Override point for subclasses to wire `passport.use(this.passportName, ...)`.
   * The base is a no-op — both config and JWT settings arrive via the
   * constructor, so there's nothing left for it to do. Subclass overrides
   * should not call super.
   */
  initializePassport(): void {}

  /**
   * Generate JWT token from user object using this Application's secret.
   */
  protected generateToken(user: NexxusApiUser): string {
    return jwt.sign(user, this.jwtSecret,
      {
        expiresIn: this.jwtExpiresIn as any,
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
    let result: [NexxusUser, 'found' | 'created'];

    if (!user) {
      user = await this.createUser(appId, {
        userType: data.userType,
        authProviders: [data.authProvider],
        username: data.username,
        details: data.details
      });

      result = [user, 'created'];
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
