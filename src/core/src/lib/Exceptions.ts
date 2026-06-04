export enum NexxusExceptions {
  FATAL_ERROR = "FatalErrorException",
  BAD_REQUEST = "BadRequestException",
  CONNECTION_ERROR = "ConnectionErrorException",
  INVALID_CONFIG = "InvalidConfigException",
  INVALID_JSON_PATCH = "InvalidJsonPatchException",
  INVALID_QUERY_FILTER = "InvalidQueryFilterException",
  INVALID_SCHEMA_DATA = "InvalidSchemaDataException",
  INVALID_USER_MODEL = "InvalidUserModelException"
};

export class NexxusException extends Error {
  constructor(type: string, message: string) {
    super(message);
    this.name = type;
  }
}

export class FatalErrorException extends NexxusException {
  constructor(message: string) {
    super(NexxusExceptions.FATAL_ERROR, message);
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
