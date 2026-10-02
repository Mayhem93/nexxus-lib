import { NexxusException } from "@mayhem93/nexxus-core-lib";

export enum NexxusWsExceptions {
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  INVALID_PARAMETERS = "INVALID_PARAMETERS",
  DEVICE_NOT_FOUND = "DEVICE_NOT_FOUND",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  SESSION_ENDED = "SESSION_ENDED"
};

export abstract class NexxusWsException extends NexxusException {
  constructor(type: NexxusWsExceptions, message: string) {
    super(type, message);
  }
}

export class NexxusWsInternalServerException extends NexxusWsException {
  constructor(message: string) {
    super(NexxusWsExceptions.INTERNAL_SERVER_ERROR, message);
  }
}

export class NexxusWsInvalidParametersException extends NexxusWsException {
  constructor(message: string) {
    super(NexxusWsExceptions.INVALID_PARAMETERS, message);
  }
}

export class NexxusWsDeviceNotFoundException extends NexxusWsException {
  constructor(message: string) {
    super(NexxusWsExceptions.DEVICE_NOT_FOUND, message);
  }
}

/** The token presented has expired. The client refreshes it and sends it again. */
export class NexxusWsTokenExpiredException extends NexxusWsException {
  constructor(message: string) {
    super(NexxusWsExceptions.TOKEN_EXPIRED, message);
  }
}

/** The session the token belongs to is over. Refreshing won't help; the client needs a new session. */
export class NexxusWsSessionEndedException extends NexxusWsException {
  constructor(message: string) {
    super(NexxusWsExceptions.SESSION_ENDED, message);
  }
}
