import { NexxusException } from "@mayhem93/nexxus-core-lib";

enum ApiExceptions {
  INVALID_PARAMETERS = "InvalidParametersException",
  NOT_FOUND = "NotFoundException",
  SERVER_ERROR = "ServerErrorException",
  SERVICE_UNAVAILABLE = "ServiceUnavailableException",
  APPLICATION_NOT_FOUND = "ApplicationNotFoundException",
  MODEL_NOT_FOUND = "ModelNotFoundException",
  ACCESS_DENIED = "AccessDeniedException",
  DEVICE_NOT_CONNECTED = "DeviceNotConnectedException",
  INVALID_AUTH_METHOD = "InvalidAuthMethodException",
  NO_AUTH_PRESENT = "NoAuthPresentException",
  USER_AUTH_FAILED = "UserAuthenticationFailedException",
  USER_TOKEN_EXPIRED = "UserTokenExpiredException",
  USER_ALREADY_EXISTS = "UserAlreadyExistsException"
};

export abstract class NexxusApiException extends NexxusException {
  public abstract readonly statusCode: number;

  constructor(name: ApiExceptions, message: string) {
    super(name, message);
  }
}

export class InvalidParametersException extends NexxusApiException {
  public readonly statusCode = 400;

  constructor(message: string) {
    super(ApiExceptions.INVALID_PARAMETERS, message);
  }
}

export class ServerErrorException extends NexxusApiException {
  public readonly statusCode = 500;

  constructor(message: string) {
    super(ApiExceptions.SERVER_ERROR, message);
  }
}

/**
 * Thrown by the availability middleware when one or more of the API's
 * upstream services (DB, MQ, Redis) is currently disconnected. Message is
 * deliberately opaque — clients don't need to know WHICH service is down,
 * only that the API cannot serve their request and they should retry.
 */
export class ServiceUnavailableException extends NexxusApiException {
  public readonly statusCode = 503;

  constructor(message: string = 'Service temporarily unavailable, please retry') {
    super(ApiExceptions.SERVICE_UNAVAILABLE, message);
  }
}
export class NotFoundException extends NexxusApiException {
  public readonly statusCode = 404;

  constructor(message: string) {
    super(ApiExceptions.NOT_FOUND, message);
  }
}

export class ApplicationNotFoundException extends NexxusApiException {
  public readonly statusCode = 404;

  constructor(message: string) {
    super(ApiExceptions.APPLICATION_NOT_FOUND, message);
  }
}

export class ModelNotFoundException extends NexxusApiException {
  public readonly statusCode = 404;

  constructor(message: string) {
    super(ApiExceptions.MODEL_NOT_FOUND, message);
  }
}

/**
 * Thrown by the ACL middleware when the app has ACLs enabled and the request
 * isn't permitted. Message is deliberately generic so a denial doesn't leak
 * which policy/condition failed (or whether the target even exists).
 */
export class AccessDeniedException extends NexxusApiException {
  public readonly statusCode = 403;

  constructor(message: string = 'Access denied') {
    super(ApiExceptions.ACCESS_DENIED, message);
  }
}

export class DeviceNotConnectedException extends NexxusApiException {
  public readonly statusCode = 409;

  constructor(message: string) {
    super(ApiExceptions.DEVICE_NOT_CONNECTED, message);
  }
}

export class InvalidAuthMethodException extends NexxusApiException {
  public readonly statusCode = 400;

  constructor(message: string) {
    super(ApiExceptions.INVALID_AUTH_METHOD, message);
  }
}

export class UserAuthenticationFailedException extends NexxusApiException {
  public readonly statusCode = 401;

  constructor(message: string) {
    super(ApiExceptions.USER_AUTH_FAILED, message);
  }
}

export class NoAuthPresentException extends NexxusApiException {
  public readonly statusCode = 401;

  constructor(message: string) {
    super(ApiExceptions.NO_AUTH_PRESENT, message);
  }
}

export class UserTokenExpiredException extends NexxusApiException {
  public readonly statusCode = 401;

  constructor(message: string) {
    super(ApiExceptions.USER_TOKEN_EXPIRED, message);
  }
}

export class UserAlreadyExistsException extends NexxusApiException {
  public readonly statusCode = 409;

  constructor(message: string) {
    super(ApiExceptions.USER_ALREADY_EXISTS, message);
  }
}

