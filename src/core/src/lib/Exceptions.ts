export enum NexxusExceptions {
  FATAL_ERROR = "FatalErrorException",
  BAD_REQUEST = "BadRequestException",
  CONNECTION_ERROR = "ConnectionErrorException",
  INVALID_CONFIG = "InvalidConfigException",
  INVALID_JSON_PATCH = "InvalidJsonPatchException",
  INVALID_QUERY_FILTER = "InvalidQueryFilterException",
  INVALID_SCHEMA_DATA = "InvalidSchemaDataException",
  INVALID_USER_MODEL = "InvalidUserModelException",
  TOKEN_EXPIRED = "TokenExpiredException",
  INVALID_TOKEN = "InvalidTokenException"
};

export class NexxusException extends Error {
  public readonly subcode?: string;

  constructor(type: string, message: string, subcode?: string) {
    super(message);
    this.name = type;
    this.subcode = subcode;
  }
}

export const enum FatalErrorSubcodes {
  FATAL_ERROR = "FATAL_ERROR",
  CONFIG_FILE_NOT_FOUND = "CONFIG_FILE_NOT_FOUND",
  CONFIG_FILE_INVALID_JSON = "CONFIG_FILE_INVALID_JSON",
  CONFIG_FILE_INVALID_SCHEMA = "CONFIG_FILE_INVALID_SCHEMA",
  CONFIG_FILE_UNREADABLE = "CONFIG_FILE_UNREADABLE"
};

export class FatalErrorException extends NexxusException {
  constructor(message: string, subcode: FatalErrorSubcodes = FatalErrorSubcodes.FATAL_ERROR) {
    super(NexxusExceptions.FATAL_ERROR, message, subcode);
  }
}

export class BadRequestException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.BAD_REQUEST, message);
  }
}

export class ConnectionException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.CONNECTION_ERROR, message);
  }
}

export class InvalidConfigException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.INVALID_CONFIG, message);
  }
}

export class InvalidJsonPatchException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.INVALID_JSON_PATCH, message);
  }
}

export class InvalidQueryFilterException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.INVALID_QUERY_FILTER, message);
  }
}

export class InvalidSchemaDataException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.INVALID_SCHEMA_DATA, message);
  }
}

export class InvalidUserModelException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.INVALID_USER_MODEL, message);
  }
}

/**
 * A token was well-formed and correctly signed, but its lifetime has passed.
 * Separate from `InvalidTokenException` because it's the one verification
 * failure a client can act on by re-authenticating.
 */
export class TokenExpiredException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.TOKEN_EXPIRED, message);
  }
}

/**
 * A token failed verification for any reason other than expiry: bad signature,
 * malformed, or issued for a different application.
 */
export class InvalidTokenException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.INVALID_TOKEN, message);
  }
}
