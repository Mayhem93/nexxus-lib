import { NexxusException } from "@mayhem93/nexxus-core-lib";

export enum NexxusWsExceptions {
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  INVALID_PARAMETERS = "INVALID_PARAMETERS",
  DEVICE_NOT_REGISTERED = "DEVICE_NOT_REGISTERED",
  DEVICE_NOT_FOUND = "DEVICE_NOT_FOUND"
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

export class NexxusWsDeviceNotRegisteredException extends NexxusWsException {
  constructor(message: string) {
    super(NexxusWsExceptions.DEVICE_NOT_REGISTERED, message);
  }
}

export class NexxusWsDeviceNotFoundException extends NexxusWsException {
  constructor(message: string) {
    super(NexxusWsExceptions.DEVICE_NOT_FOUND, message);
  }
}
