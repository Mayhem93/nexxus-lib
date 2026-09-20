import { describe, it, expect, beforeEach } from 'vitest';
import { NexxusDevice } from '@mayhem93/nexxus-redis';

import { resolveDevice } from '../../src/api/src/lib/DeviceRegistration';

import { installApiStatics, makeApp, makeAuthApp, dbState, logger } from './harness';
import { installFakeRedis } from '../redis/helpers';

/** Put a device in Redis directly, standing in for one registered earlier. */
async function existingDevice(props: {
  id: string;
  appId?: string;
  userId?: string;
  name?: string;
}): Promise<NexxusDevice> {
  const device = new NexxusDevice({
    id: props.id,
    appId: props.appId ?? 'app1',
    userId: props.userId,
    name: props.name ?? 'Old Phone',
    subscriptions: [],
  });

  await device.save();

  return device;
}

describe('resolveDevice — no hint', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  it('creates a device bound to the application', async () => {
    const device = await resolveDevice(makeApp(), undefined);

    expect(device.getValue()).toMatchObject({ appId: 'app1', name: 'Unnamed Device' });
    expect(device.getValue().id).toEqual(expect.any(String));
  });

  it('persists it, so the id in the token resolves next time', async () => {
    const device = await resolveDevice(makeApp(), undefined);

    await expect(NexxusDevice.get(device.getValue().id)).resolves.toBeDefined();
  });

  it('uses the supplied name', async () => {
    expect((await resolveDevice(makeApp(), undefined, { name: 'Ann\'s Laptop' })).getValue().name)
      .toBe('Ann\'s Laptop');
  });

  it('records the owner when there is one', async () => {
    expect((await resolveDevice(makeAuthApp(), 'u1')).getValue().userId).toBe('u1');
  });

  it('leaves the device unowned on an application without authentication', async () => {
    expect((await resolveDevice(makeApp(), undefined)).getValue().userId).toBeUndefined();
  });

  it('links the device to the user document so /device/list can find it', async () => {
    const device = await resolveDevice(makeAuthApp(), 'u1');
    const patches = dbState.updateCalls[0]!.patches;

    expect(patches[0].get()).toMatchObject({
      op: 'append', path: [ 'devices' ], value: [ device.getValue().id ],
      metadata: { appId: 'app1', id: 'u1', type: 'user' },
    });
    expect(patches[1].get()).toMatchObject({ op: 'replace', path: [ 'updatedAt' ] });
  });

  it('writes no user patch when there is no user to link to', async () => {
    await resolveDevice(makeApp(), undefined);

    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('issues a distinct device per call', async () => {
    const first = await resolveDevice(makeApp(), undefined);
    const second = await resolveDevice(makeApp(), undefined);

    // A client that loses its hint — a reinstall — is a new installation, and
    // shows up as a separate entry in the device list. That's intended.
    expect(first.getValue().id).not.toBe(second.getValue().id);
  });
});

describe('resolveDevice — hint resolves to the caller\'s own device', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  it('reuses it rather than accruing a new one', async () => {
    await existingDevice({ id: 'd1', userId: 'u1' });

    const device = await resolveDevice(makeAuthApp(), 'u1', { id: 'd1' });

    // The whole point: a 7-day token expiring and the user signing in again
    // must not leave a new device record behind every week.
    expect(device.getValue().id).toBe('d1');
  });

  it('refreshes lastSeen', async () => {
    await existingDevice({ id: 'd1', userId: 'u1' });

    await resolveDevice(makeAuthApp(), 'u1', { id: 'd1' });

    expect((await NexxusDevice.get('d1')).getValue().lastSeen).toBeInstanceOf(Date);
  });

  it('does not re-link an already-linked device to the user', async () => {
    await existingDevice({ id: 'd1', userId: 'u1' });

    await resolveDevice(makeAuthApp(), 'u1', { id: 'd1' });

    // Appending again would leave duplicate ids on the user document.
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('keeps the stored name rather than taking the hint\'s', async () => {
    await existingDevice({ id: 'd1', userId: 'u1', name: 'Old Phone' });

    const device = await resolveDevice(makeAuthApp(), 'u1', { id: 'd1', name: 'Renamed' });

    // Renaming is `PUT /device`'s job — a login shouldn't silently rewrite it.
    expect(device.getValue().name).toBe('Old Phone');
  });

  it('reuses an unowned device on an application without authentication', async () => {
    await existingDevice({ id: 'd1' });

    expect((await resolveDevice(makeApp(), undefined, { id: 'd1' })).getValue().id).toBe('d1');
  });
});

describe('resolveDevice — hint the caller may not claim', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  it('issues a new device when the hint names nothing', async () => {
    const device = await resolveDevice(makeAuthApp(), 'u1', { id: 'reaped-long-ago' });

    // A stale id is not an attack: the client can't know the server forgot its
    // device, and erroring would lock out anyone with old local storage.
    expect(device.getValue().id).not.toBe('reaped-long-ago');
  });

  it('issues a new device when the hint belongs to another application', async () => {
    await existingDevice({ id: 'd1', appId: 'other-app', userId: 'u1' });

    const device = await resolveDevice(makeAuthApp(), 'u1', { id: 'd1' });

    expect(device.getValue().id).not.toBe('d1');
    expect(device.getValue().appId).toBe('app1');
  });

  it('issues a new device when the hint belongs to another user', async () => {
    await existingDevice({ id: 'd1', userId: 'someone-else' });

    const device = await resolveDevice(makeAuthApp(), 'u1', { id: 'd1' });

    expect(device.getValue().id).not.toBe('d1');
    expect(device.getValue().userId).toBe('u1');
  });

  it('does not touch the device it declined to claim', async () => {
    await existingDevice({ id: 'd1', userId: 'someone-else' });

    await resolveDevice(makeAuthApp(), 'u1', { id: 'd1' });

    expect((await NexxusDevice.get('d1')).getValue().userId).toBe('someone-else');
  });

  it('treats an empty hint id as no hint at all', async () => {
    const device = await resolveDevice(makeApp(), undefined, { id: '' });

    expect(device.getValue().id).toEqual(expect.any(String));
  });

  it('logs why it issued a new device', async () => {
    await resolveDevice(makeAuthApp(), 'u1', { id: 'reaped-long-ago' });

    expect(logger.has('debug', /Device hint "reaped-long-ago" did not resolve/)).toBe(true);
  });

  it('links the replacement device to the user', async () => {
    const device = await resolveDevice(makeAuthApp(), 'u1', { id: 'reaped-long-ago' });

    expect(dbState.updateCalls[0]!.patches[0].get().value).toEqual([ device.getValue().id ]);
  });
});

describe('resolveDevice — unexpected failures', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  it('propagates a Redis failure that is not "key not found"', async () => {
    const boom = new Error('redis exploded');

    // Only a missing key means "no such device". Anything else is a real
    // failure and must not be quietly turned into a brand new device.
    const original = NexxusDevice.get;

    (NexxusDevice as unknown as { get: unknown }).get = async () => { throw boom; };

    try {
      await expect(resolveDevice(makeAuthApp(), 'u1', { id: 'd1' })).rejects.toThrow('redis exploded');
    } finally {
      (NexxusDevice as unknown as { get: unknown }).get = original;
    }
  });
});
