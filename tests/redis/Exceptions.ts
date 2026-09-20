import { describe, it, expect } from 'vitest';
import {
  RedisConnectionErrorException,
  RedisCommandErrorException,
  RedisKeyNotFoundException,
  RedisDeviceInvalidParamsException,
  RedisDeviceNotConnectedException,
} from '@mayhem93/nexxus-redis';

describe('redis exceptions', () => {
  it('carry the right name and message and extend Error', () => {
    const cases: Array<[new (m: string) => Error, string]> = [
      [RedisConnectionErrorException, 'RedisConnectionErrorException'],
      [RedisCommandErrorException, 'RedisCommandErrorException'],
      [RedisKeyNotFoundException, 'RedisKeyNotFoundException'],
      [RedisDeviceInvalidParamsException, 'RedisDeviceInvalidParamsException'],
      [RedisDeviceNotConnectedException, 'RedisDeviceNotConnectedException'],
    ];

    for (const [Ctor, name] of cases) {
      const err = new Ctor('boom');

      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.message).toBe('boom');
    }
  });
});
