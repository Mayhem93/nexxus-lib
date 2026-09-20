import { NexxusApi, NexxusApiUser } from '../Api';
import { resolveDevice, type NexxusDeviceHint } from '../DeviceRegistration';

import { InvalidParametersException } from '../Exceptions';

import {
  NexxusUser,
  NexxusFilterQuery,
  NexxusApplication,
  NexxusToken,
  NexxusTokenMint,
  NexxusSchemaValidator,
  InvalidSchemaDataException,
  NexxusJsonPatch,
  authDetailKey,
  isReservedUserDetailField,
  type NexxusUserDetailSchema,
  INexxusUser
} from '@mayhem93/nexxus-core-lib';

import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import Ajv, { ValidateFunction } from 'ajv';
import type { JSONSchema7 } from 'json-schema';
import * as fs from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface NexxusBaseAuthStrategyConfig {
  [key: string]: unknown;
}

export type NexxusAuthProviders = 'local' | 'google' | string;

/**
 * Contents of a signed redirect-flow `state` parameter.
 *
 * `nonce` is issued through `NexxusAuthNonce` and redeemed exactly once when
 * the state comes back — that's what makes the state unreplayable. The
 * signature alone only proves nobody edited it.
 */
export type NexxusAuthStatePayload = {
  appId: string;
  userType: string;
  nonce: string;
  /**
   * The caller's device hint. A redirect flow has no request body on the way
   * back, so the only way a returning user's device id survives the round trip
   * to the provider is inside the state — which is signed, so it can't be
   * swapped for someone else's on the way.
   */
  deviceId?: string;
};

/**
 * Domain separator for deriving the state-signing key:
 *
 *   signingKey = HMAC-SHA256(key: app.signingSecret, data: this)
 *
 * Not a storage key — nothing about this reaches Redis. The point is key
 * separation: whatever signs redirect state and whatever signs access tokens
 * must never share a raw secret, so a weakness in one can't be pivoted into
 * the other. Versioned so the derivation can be rotated without ambiguity.
 */
const STATE_KEY_DERIVATION_INFO = 'auth-state-signing-key/v1';

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
  /**
   * Detail fields this strategy owns on a user, stored under `$auth_<name>`.
   * Class-level metadata like `requiresCallback` — the fields a strategy
   * records are a property of the strategy, not of any one application.
   *
   * Declared empty here: a strategy that learns nothing about the user from its
   * provider (local auth) contributes nothing, and `{}` and "not declared" mean
   * the same thing rather than being two cases to handle.
   */
  public static userDetailSchema: NexxusUserDetailSchema = {};
  protected config: T;
  /**
   * The Application this strategy instance serves. Holding the app rather than
   * a copied-out secret and expiry means the signing key, the token lifetime
   * and the audience can't drift apart here.
   */
  protected app: NexxusApplication;

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

  constructor(config: T, app: NexxusApplication) {
    NexxusAuthStrategy.validateConfig(this.constructor as typeof NexxusAuthStrategy, config);

    this.config = config;
    this.app = app;
  }

  /**
   * Derived rather than stored: the instance already holds the Application, and
   * a second copy of its id is one more thing that can go stale or be passed in
   * from somewhere else.
   */
  protected get appId(): string {
    return this.app.getData().id as string;
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
        .map(e => {
          // AJV reports an unknown key as "must NOT have additional properties"
          // and puts the key itself in `params` — so without this the operator
          // is told their config is wrong but not which line of it.
          const offending = (e.params as { additionalProperty?: string })?.additionalProperty;

          return `${e.instancePath || '#root'}: ${e.message}${offending ? ` ("${offending}")` : ''}`;
        })
        .join('; ');

      throw new Error(`Invalid config for auth strategy "${cacheKey}": ${formatted}`);
    }
  }

  /**
   * Per-app key the redirect-flow `state` parameter is signed with, derived
   * from the app's signing secret (see `STATE_KEY_DERIVATION_INFO`). Cheap enough
   * to recompute per call — one SHA-256 over a short string.
   */
  private get stateSigningKey(): Buffer {
    return createHmac('sha256', this.app.getSigningSecret()).update(STATE_KEY_DERIVATION_INFO).digest();
  }

  /**
   * Sign a redirect-flow `state` parameter as `base64url(payload).base64url(mac)`.
   *
   * The MAC covers the encoded body rather than the raw JSON, so verification
   * never has to reproduce a canonical encoding to get a matching signature.
   */
  protected signState(payload: NexxusAuthStatePayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', this.stateSigningKey).update(body).digest('base64url');

    return `${body}.${mac}`;
  }

  /**
   * Verify a `state` parameter and return its payload, or `null` if the state
   * is malformed, was signed with a different key, or claims a different
   * application than this instance serves.
   *
   * A `null` here means "don't trust anything in this state" — it does NOT mean
   * the state is unused. Redeeming the nonce is a separate step the caller owns,
   * and it's the one that prevents replay.
   */
  protected verifyState(state: string): NexxusAuthStatePayload | null {
    if (typeof state !== 'string') {
      return null;
    }

    const parts = state.split('.');

    if (parts.length !== 2) {
      return null;
    }

    const [body, mac] = parts;
    const expected = createHmac('sha256', this.stateSigningKey).update(body as string).digest('base64url');
    const given = Buffer.from(mac as string, 'utf8');
    const want = Buffer.from(expected, 'utf8');

    // timingSafeEqual throws on a length mismatch, so that's checked first —
    // and a wrong length is a wrong signature either way.
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      return null;
    }

    const payload = NexxusAuthStrategy.decodeStatePayload(body);

    // Belt and braces: the router already picked this instance by the appId in
    // the state, so a mismatch means a routing bug rather than an attack. It's
    // one comparison to make the binding explicit instead of assumed.
    return payload && payload.appId === this.appId ? payload : null;
  }

  /**
   * Read the appId out of a `state` parameter WITHOUT verifying the signature.
   *
   * Needed because signature verification requires the app's secret, and
   * finding the app is exactly what the router is trying to do — so this only
   * ever selects which key to verify against. A forged appId selects a
   * different key, and `verifyState` then rejects the signature.
   */
  public static peekStateAppId(state: string): string | null {
    if (typeof state !== 'string') {
      return null;
    }

    return NexxusAuthStrategy.decodeStatePayload(state.split('.')[0])?.appId ?? null;
  }

  private static decodeStatePayload(body: string | undefined): NexxusAuthStatePayload | null {
    if (!body) {
      return null;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const { appId, userType, nonce, deviceId } = parsed as Record<string, unknown>;

    if (typeof appId !== 'string' || typeof userType !== 'string' || typeof nonce !== 'string') {
      return null;
    }

    return {
      appId,
      userType,
      nonce,
      // Optional, and only carried through when it's actually a string — a
      // malformed hint is dropped rather than failing the whole state.
      ...(typeof deviceId === 'string' ? { deviceId } : {})
    };
  }

  /**
   * Override point for subclasses to wire `passport.use(this.passportName, ...)`.
   * The base is a no-op — config and the owning application both arrive via the
   * constructor, so there's nothing left for it to do. Subclass overrides
   * should not call super.
   */
  initializePassport(): void {}

  /**
   * Generate a token for this Application from a user object.
   *
   * Signing itself lives in core (`NexxusToken`) so the transport workers, which
   * verify these tokens but have no strategies, share exactly one implementation.
   */
  protected generateToken(user: NexxusApiUser, deviceId: string): string {
    const claims: NexxusTokenMint = { appId: this.appId, deviceId, user };

    return NexxusToken.issue(this.app, claims);
  }

  /**
   * Complete a successful authentication: resolve the calling device, mint a
   * token bound to it, and send both back.
   *
   * The device is resolved HERE, in the one place every strategy funnels
   * through, so no strategy can forget to bind a token to a device. The client
   * should store `device.id` and pass it back as the hint next time it
   * authenticates — that's what keeps a token expiring from turning into a new
   * device record every week.
   *
   * Public because `/user/register` finishes the same way: it creates a user
   * and then hands back a usable session rather than making the client turn
   * straight around and log in.
   */
  public async sendTokenResponse(
    res: Response,
    user: NexxusApiUser,
    deviceHint?: NexxusDeviceHint
  ): Promise<void> {
    const device = await resolveDevice(this.app, user.id, deviceHint);
    const deviceId = device.getValue().id;

    res.json({
      token: this.generateToken(user, deviceId),
      device: {
        id: deviceId,
        name: device.getValue().name
      },
      user: {
        id: user.id,
        username: user.username
      }
    });
  }

  /** This strategy's namespace inside a user's `details`. */
  protected get authDetailKey(): string {
    return authDetailKey(this.name);
  }

  /**
   * Validate CALLER-SUPPLIED `details` against the application's detail schema
   * for a user type, returning the normalized result.
   *
   * This lives on the base class because every strategy that can create an
   * account needs it and none of them should be deciding for itself what a
   * valid profile looks like — the local route, Google, and whatever comes
   * next all write into the same `details` field on the same model.
   *
   * Reserved `$` fields are refused up front even though the schema now
   * declares them: `getUserDetailSchema` merges in the `$auth_*` namespaces, so
   * without this a registration body carrying `{"$auth_google":{"id":"..."}}`
   * would validate cleanly and mint an account pre-linked to someone else's
   * provider identity. Schema membership answers "is this a real field", not
   * "is this caller allowed to write it".
   *
   * Validated as a nested object rather than through `validateAgainstSchema`:
   * `details` IS one, so it gets the closed-schema treatment with no
   * reserved-name exemption — a detail field called `id` is undeclared like
   * any other.
   */
  protected validateUserDetails(userType: string, details: Record<string, any>): Record<string, any> {
    const reserved = Object.keys(details).filter(isReservedUserDetailField);

    if (reserved.length > 0) {
      throw new InvalidParametersException(
        `User detail field(s) "${reserved.join('", "')}" are set by Nexxus and cannot be supplied`
      );
    }

    const detailSchema = this.app.getUserDetailSchema(userType);

    if (!detailSchema) {
      throw new InvalidParametersException(`No user detail schema for user type "${userType}"`);
    }

    try {
      return NexxusSchemaValidator.validateValue(
        details,
        { type: 'object', required: false, properties: detailSchema },
        'details'
      ) as Record<string, any>;
    } catch (e) {
      if (e instanceof InvalidSchemaDataException) {
        throw new InvalidParametersException(`Invalid user details: ${e.message}`);
      }

      throw e;
    }
  }

  /**
   * Validate the fields THIS strategy owns, to be stored at `$auth_<name>`.
   *
   * Checked against the strategy class's own `userDetailSchema` rather than the
   * app's merged one, so a strategy can only ever write inside its own
   * namespace and a bug in one provider's mapping can't corrupt another's.
   */
  protected validateOwnAuthDetails(details: Record<string, any>): Record<string, any> {
    const ownSchema = (this.constructor as typeof NexxusAuthStrategy).userDetailSchema;

    try {
      return NexxusSchemaValidator.validateValue(
        details,
        { type: 'object', required: false, properties: ownSchema },
        this.authDetailKey
      ) as Record<string, any>;
    } catch (e) {
      if (e instanceof InvalidSchemaDataException) {
        throw new InvalidParametersException(`Invalid ${this.name} auth details: ${e.message}`);
      }

      throw e;
    }
  }

  /**
   * Find user by username (email)
   */
  public async findUserByUsername(username: string): Promise<NexxusUser | null> {
    const fq = new NexxusFilterQuery({ username }, NexxusUser.getModelSchema(this.app.getUserDetailSchema()));

    const res = await NexxusApi.database.searchItems({
      appId: this.appId,
      type: 'user',
      filter: fq
    });

    return res.length > 0 ? res[0] : null;
  }

  /**
   * Create new user
   * For local strategy: includes password hash
   * For OAuth: password is null
   *
   * No `appId` parameter: the instance serves exactly one application, so
   * taking one would let a caller hand this a different app than the one whose
   * strategy config, signing key and detail schema are in play here.
   */
  public async createUser(data: {
    username: string;
    userType?: string;
    password?: string;
    authProviders: NexxusAuthProviders[];
    /** Caller-supplied profile fields. Reserved `$` fields are refused. */
    details?: Record<string, any>;
    /** This strategy's own fields, stored under `$auth_<name>`. */
    authDetails?: Record<string, any>;
  }): Promise<NexxusUser> {
    const userType = data.userType || 'default';
    const details = this.validateUserDetails(userType, data.details || {});

    if (data.authDetails) {
      details[this.authDetailKey] = this.validateOwnAuthDetails(data.authDetails);
    }

    const userData: INexxusUser = {
      type: 'user',
      appId: this.appId,
      userType,
      username: data.username,
      password: data.password ? await NexxusAuthStrategy.hashPassword(data.password) : null,
      authProviders: data.authProviders,
      devices: [],
      details
    };
    const user = new NexxusUser(userData);

    await NexxusApi.database.createItems([ user ]);

    return user;
  }

  /**
   * Find user by username, create if doesn't exist (for OAuth)
   *
   * On the FOUND branch the provider's details are written too, not dropped:
   * that branch is how an existing account gets linked to this provider, and an
   * account linked to a provider with no record of what the provider said about
   * it is the same as not being linked.
   */
  protected async findOrCreateUser(data: {
    username: string;
    userType?: string;
    authProvider: NexxusAuthProviders;
    authDetails?: Record<string, any>;
  }): Promise<[NexxusUser, 'found' | 'created']> {
    const user = await this.findUserByUsername(data.username);

    if (!user) {
      return [
        await this.createUser({
          userType: data.userType,
          authProviders: [data.authProvider],
          username: data.username,
          authDetails: data.authDetails
        }),
        'created'
      ];
    }

    if (data.authDetails) {
      await this.writeOwnAuthDetails(user, data.authDetails);
    }

    return [user, 'found'];
  }

  /**
   * Persist this strategy's `$auth_<name>` subtree on an existing user, and
   * mirror it onto the in-memory model so the caller doesn't have to re-read.
   */
  private async writeOwnAuthDetails(user: NexxusUser, authDetails: Record<string, any>): Promise<void> {
    const validated = this.validateOwnAuthDetails(authDetails);
    const userType = user.getData().userType;
    const path = `details.${this.authDetailKey}`;
    const metadata = { appId: this.appId, id: user.getData().id!, type: 'user' };

    const detailsPatch = new NexxusJsonPatch({ op: 'replace', path: [ path ], value: [ validated ], metadata });
    const updatedAtPatch = new NexxusJsonPatch({
      op: 'replace', path: [ 'updatedAt' ], value: [ new Date() ], metadata
    });
    const userSchema = NexxusUser.getModelSchema(this.app.getUserDetailSchema(userType));

    detailsPatch.validate(userSchema);
    updatedAtPatch.validate(userSchema);

    await NexxusApi.database.updateItems([ detailsPatch, updatedAtPatch ]);

    user.getData().details = { ...user.getData().details, [this.authDetailKey]: validated };
  }

  /**
   * Public so routes that authenticate a user outside a strategy
   * (`/user/register`) can shape it the same way.
   *
   * Reserved `$` details are stripped. This object becomes the token's `user`
   * claim, so it travels in the Authorization header of every request and is
   * returned verbatim by `/user/me` — provider bookkeeping belongs in neither.
   * `authProviders` already tells a client which providers are linked, which is
   * the only part of it a client has any use for.
   */
  public static convertToApiUser(user: NexxusUser): NexxusApiUser {
    const data = user.getData();
    const details = Object.fromEntries(
      Object.entries(data.details ?? {}).filter(([ field ]) => !isReservedUserDetailField(field))
    );

    return {
      id: data.id!,
      username: data.username,
      userType: data.userType,
      authProviders: data.authProviders,
      details,
      appId: data.appId
    };
  }

  /**
   * bcrypt is deliberately slow — that's the point of it — and at cost factor 10
   * a hash is tens of milliseconds of pure CPU. The sync variants ran that on
   * the event loop, so every concurrent request stalled behind each login and
   * registration. The async ones hand the work to libuv's thread pool instead.
   */
  public static hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  protected static verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }
}
