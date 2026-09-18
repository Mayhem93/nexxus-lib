import { describe, it, expect } from 'vitest';
import { NexxusException } from '@mayhem93/nexxus-core-lib';

import {
  NexxusApiException,
  InvalidParametersException,
  ServerErrorException,
  ServiceUnavailableException,
  NotFoundException,
  ApplicationNotFoundException,
  ModelNotFoundException,
  AccessDeniedException,
  DeviceNotConnectedException,
  InvalidAuthMethodException,
  UserAuthenticationFailedException,
  NoAuthPresentException,
  UserTokenExpiredException,
  UserAlreadyExistsException,
} from '../../src/api/src/lib/Exceptions';

/**
 * Every exception's `statusCode` and `name` reach the client verbatim — the
 * error middleware renders `{ error: err.name, message }` at `err.statusCode` —
 * so this table IS the API's error contract, not an implementation detail. A
 * table rather than thirteen near-identical blocks because the mapping is the
 * thing being asserted, and a table shows it at a glance.
 */
const CONTRACT: Array<[new (message: string) => NexxusApiException, number, string]> = [
  [ InvalidParametersException,        400, 'InvalidParametersException' ],
  [ InvalidAuthMethodException,        400, 'InvalidAuthMethodException' ],
  [ UserAuthenticationFailedException, 401, 'UserAuthenticationFailedException' ],
  [ NoAuthPresentException,            401, 'NoAuthPresentException' ],
  [ UserTokenExpiredException,         401, 'UserTokenExpiredException' ],
  [ AccessDeniedException,             403, 'AccessDeniedException' ],
  [ NotFoundException,                 404, 'NotFoundException' ],
  [ ApplicationNotFoundException,      404, 'ApplicationNotFoundException' ],
  [ ModelNotFoundException,            404, 'ModelNotFoundException' ],
  [ DeviceNotConnectedException,       409, 'DeviceNotConnectedException' ],
  [ UserAlreadyExistsException,        409, 'UserAlreadyExistsException' ],
  [ ServerErrorException,              500, 'ServerErrorException' ],
  [ ServiceUnavailableException,       503, 'ServiceUnavailableException' ],
];

describe('API exceptions — status code and name contract', () => {
  it.each(CONTRACT)('%# %o carries its status code and name', (Ctor, statusCode, name) => {
    const e = new Ctor('boom');

    expect(e.statusCode).toBe(statusCode);
    expect(e.name).toBe(name);
    expect(e.message).toBe('boom');
  });

  it('names every exception after its own class', () => {
    // The `name` is what a client switches on, so a copy-paste slip in the
    // enum — two classes sharing a name — would be invisible until someone
    // debugged a mis-branching client.
    for (const [ Ctor, , name ] of CONTRACT) {
      expect(name).toBe(Ctor.name);
    }

    expect(new Set(CONTRACT.map(([ , , name ]) => name)).size).toBe(CONTRACT.length);
  });
});

describe('API exceptions — inheritance', () => {
  /**
   * Load-bearing: the error middleware replaces anything that ISN'T a
   * `NexxusException` with a generic 500. An exception that broke this chain
   * wouldn't throw or fail to compile — every one of its throws would just
   * quietly start rendering as "An unexpected server error occurred."
   */
  it.each(CONTRACT)('%# %o extends both NexxusApiException and core NexxusException', (Ctor) => {
    const e = new Ctor('boom');

    expect(e).toBeInstanceOf(NexxusApiException);
    expect(e).toBeInstanceOf(NexxusException);
    expect(e).toBeInstanceOf(Error);
  });

  it('captures a stack trace', () => {
    // The error middleware logs `err.stack` for 5xx; a missing one turns the
    // one log line that explains a 500 into "undefined".
    expect(new ServerErrorException('boom').stack).toContain('ServerErrorException');
  });
});

describe('API exceptions — deliberately opaque defaults', () => {
  it('defaults AccessDenied to a message that names nothing', () => {
    // A denial must not reveal which policy failed, or whether the target
    // exists at all — otherwise 403 becomes an existence oracle.
    expect(new AccessDeniedException().message).toBe('Access denied');
  });

  it('defaults ServiceUnavailable to a message that names no service', () => {
    const message = new ServiceUnavailableException().message;

    expect(message).toBe('Service temporarily unavailable, please retry');
    expect(message).not.toMatch(/database|redis|queue|elastic|rabbit/i);
  });

  it('still allows an explicit message to override either default', () => {
    expect(new AccessDeniedException('custom').message).toBe('custom');
    expect(new ServiceUnavailableException('custom').message).toBe('custom');
  });
});
