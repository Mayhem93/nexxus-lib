import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NexxusToken, NexxusUser, type INexxusUser, type NexxusApplication } from '@mayhem93/nexxus-core-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';

import DeviceRoute from '../../src/api/src/lib/routes/Device';

import {
  installApiStatics, seedApp, makeApp, makeAuthApp, dbState, logger,
  startTestServer, type TestServer,
} from './harness';
import { installFakeRedis } from '../redis/helpers';

const USER = {
  id: 'u1', username: 'ann', userType: 'default',
  authProviders: [ 'local' ], details: {}, appId: 'app1',
} as never;

let server: TestServer;
let app: NexxusApplication;

/** Auth header for a token bound to `deviceId`, optionally carrying the user. */
function as(deviceId: string, user?: unknown): Record<string, string> {
  return {
    'nxx-app-id': 'app1',
    authorization: `Bearer ${NexxusToken.issue(app, { appId: 'app1', deviceId, user: user as never })}`,
  };
}

const APP_ONLY = { 'nxx-app-id': 'app1' };

const post = (path: string, body: unknown, headers: Record<string, string>) => server.request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const put = (path: string, body: unknown, headers: Record<string, string>) => server.request(path, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** Register a device directly in Redis, standing in for one registered earlier. */
async function seedDevice(props: { id: string; appId?: string; userId?: string; name?: string }): Promise<void> {
  await new NexxusDevice({
    id: props.id,
    appId: props.appId ?? 'app1',
    userId: props.userId,
    name: props.name ?? 'Old Phone',
    subscriptions: [],
  }).save();
}

async function serve(application: NexxusApplication): Promise<void> {
  app = seedApp(application);
  server = await startTestServer(expressApp => { new DeviceRoute(expressApp); });
}

describe('POST /device/register', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('registers a device and returns a token bound to it', async () => {
    await serve(makeAuthApp());

    const res = await post('/device/register', { name: 'Ann\'s Laptop' }, as('d-existing', USER));

    expect(res.status).toBe(200);
    expect(res.body.device).toMatchObject({ appId: 'app1', name: 'Ann\'s Laptop', userId: 'u1' });
    // A token for the NEW device, not the one that authorized the call —
    // otherwise the caller holds an id it cannot use.
    expect(NexxusToken.verify(app, res.body.token).deviceId).toBe(res.body.device.id);
    expect(res.body.device.id).not.toBe('d-existing');
  });

  it('works on an application with no authentication, leaving the device unowned', async () => {
    await serve(makeApp());

    const res = await post('/device/register', { name: 'Kiosk' }, APP_ONLY);

    expect(res.status).toBe(200);
    expect(res.body.device.userId).toBeUndefined();
    expect(NexxusToken.verify(app, res.body.token).user).toBeUndefined();
  });

  it('carries the principal into the new device\'s token', async () => {
    await serve(makeAuthApp());

    const res = await post('/device/register', { name: 'Laptop' }, as('d1', USER));

    expect(NexxusToken.verify(app, res.body.token).user).toMatchObject({ id: 'u1' });
  });

  it('always creates, never reuses — this is the "register another device" path', async () => {
    await serve(makeAuthApp());

    const first = await post('/device/register', { name: 'Laptop' }, as('d1', USER));
    const second = await post('/device/register', { name: 'Phone' }, as('d1', USER));

    expect(second.body.device.id).not.toBe(first.body.device.id);
  });

  it('requires a device name', async () => {
    await serve(makeAuthApp());

    for (const body of [ {}, { name: '' }, { name: 42 } ]) {
      const res = await post('/device/register', body, as('d1', USER));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/device name/);
    }
  });

  it('requires the application header', async () => {
    await serve(makeAuthApp());

    expect((await post('/device/register', { name: 'x' }, {})).status).toBe(400);
  });

  it('404s an unknown application', async () => {
    await serve(makeAuthApp());

    const res = await post('/device/register', { name: 'x' }, { 'nxx-app-id': 'ghost' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ApplicationNotFoundException');
  });

  it('401s when an application WITH auth gets no token', async () => {
    await serve(makeAuthApp());

    // No RequiresUser on this route — a zero-auth app must be able to register
    // a device — so the rejection comes from AuthMiddleware, not the handler.
    expect((await post('/device/register', { name: 'x' }, APP_ONLY)).status).toBe(401);
  });

  it('persists the device so a later request can load it', async () => {
    await serve(makeAuthApp());

    const res = await post('/device/register', { name: 'Laptop' }, as('d1', USER));

    await expect(NexxusDevice.get(res.body.device.id)).resolves.toBeDefined();
  });
});

describe('GET /device', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('returns the device the caller\'s token names', async () => {
    await serve(makeAuthApp());
    await seedDevice({ id: 'd1', userId: 'u1', name: 'Ann\'s Phone' });

    const res = await server.request('/device', { headers: as('d1', USER) });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'd1', name: 'Ann\'s Phone' });
  });

  /**
   * There is no device parameter to pass — a caller can only ever address the
   * device its own token was issued to. That is what closes the cross-tenant
   * read the `nxx-device-id` header left open: it isn't a check that can fail,
   * it's a request that can't be expressed.
   */
  it('offers no way to name a different device', async () => {
    await serve(makeAuthApp());
    await seedDevice({ id: 'd1', userId: 'u1' });
    await seedDevice({ id: 'victim', userId: 'someone-else', name: 'Victim Phone' });

    const res = await server.request('/device?id=victim', {
      headers: { ...as('d1', USER), 'nxx-device-id': 'victim' },
    });

    expect(res.body.id).toBe('d1');
  });

  it('404s when the record is gone', async () => {
    await serve(makeAuthApp());

    // A structurally valid token for a device Redis no longer holds — reaped,
    // or a stale token. A 404, not the 500 a raw Redis exception would give.
    const res = await server.request('/device', { headers: as('reaped', USER) });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'NotFoundException' });
  });

  it('400s a token that names no device', async () => {
    await serve(makeApp());

    const res = await server.request('/device', { headers: APP_ONLY });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/POST \/device\/register/);
  });

  it('does not turn a Redis outage into "device not found"', async () => {
    await serve(makeAuthApp());

    // Only a missing key means the device is gone. Reporting an infrastructure
    // failure as a 404 would send clients into a re-registration loop, each one
    // creating another orphan record.
    const original = NexxusDevice.get;

    (NexxusDevice as unknown as { get: unknown }).get = async () => { throw new Error('redis exploded'); };

    try {
      const res = await server.request('/device', { headers: as('d1', USER) });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('ServerErrorException');
    } finally {
      (NexxusDevice as unknown as { get: unknown }).get = original;
    }
  });
});

describe('PUT /device', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('renames the calling device', async () => {
    await serve(makeAuthApp());
    await seedDevice({ id: 'd1', userId: 'u1', name: 'Old Phone' });

    const res = await put('/device', { name: 'New Phone' }, as('d1', USER));

    expect(res.status).toBe(200);
    expect((await NexxusDevice.get('d1')).getValue().name).toBe('New Phone');
  });

  it('cannot rename anyone else\'s device', async () => {
    await serve(makeAuthApp());
    await seedDevice({ id: 'd1', userId: 'u1' });
    await seedDevice({ id: 'victim', userId: 'someone-else', name: 'Victim Phone' });

    await put('/device', { name: 'Pwned' }, { ...as('d1', USER), 'nxx-device-id': 'victim' });

    expect((await NexxusDevice.get('victim')).getValue().name).toBe('Victim Phone');
  });

  it('requires a name', async () => {
    await serve(makeAuthApp());
    await seedDevice({ id: 'd1', userId: 'u1' });

    for (const body of [ {}, { name: '' }, { name: 42 } ]) {
      expect((await put('/device', body, as('d1', USER))).status).toBe(400);
    }
  });

  it('400s a token that names no device', async () => {
    await serve(makeApp());

    expect((await put('/device', { name: 'x' }, APP_ONLY)).status).toBe(400);
  });
});

describe('GET /device/list', () => {
  const storedUser = (devices: string[]): NexxusUser => new NexxusUser({
    id: 'u1', type: 'user', appId: 'app1', username: 'ann', password: null,
    authProviders: [ 'local' ], devices, details: {}, userType: 'default',
  } as INexxusUser);

  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('lists the devices on the caller\'s user document', async () => {
    await serve(makeAuthApp());
    await seedDevice({ id: 'd1', userId: 'u1', name: 'Phone' });
    await seedDevice({ id: 'd2', userId: 'u1', name: 'Laptop' });
    dbState.getItemsResult = [ storedUser([ 'd1', 'd2' ]) ];

    const res = await server.request('/device/list', { headers: as('d1', USER) });

    expect(res.status).toBe(200);
    expect(res.body.devices.map((d: { name: string }) => d.name).sort()).toEqual([ 'Laptop', 'Phone' ]);
  });

  /**
   * The id list lives on the user document while the records live in Redis, so
   * the two drift — a reaped device leaves an id behind. `Promise.all` made one
   * dangling id fail the whole endpoint, leaving a user unable to see ANY of
   * their devices until someone pruned it by hand.
   */
  it('survives a dangling device id', async () => {
    await serve(makeAuthApp());
    await seedDevice({ id: 'd1', userId: 'u1', name: 'Phone' });
    dbState.getItemsResult = [ storedUser([ 'd1', 'reaped-long-ago' ]) ];

    const res = await server.request('/device/list', { headers: as('d1', USER) });

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    // 'warning', not 'warn' — NexxusLoggerLevels uses syslog names.
    expect(logger.has('warning', /lists 2 devices but only 1 could be read/)).toBe(true);
  });

  it('returns an empty list for a user with no devices', async () => {
    await serve(makeAuthApp());
    dbState.getItemsResult = [ storedUser([]) ];

    expect((await server.request('/device/list', { headers: as('d1', USER) })).body.devices).toEqual([]);
  });

  it('returns an empty list when the user document is missing', async () => {
    await serve(makeAuthApp());
    dbState.getItemsResult = [];

    expect((await server.request('/device/list', { headers: as('d1', USER) })).body.devices).toEqual([]);
  });

  it('requires a principal, not merely a device', async () => {
    await serve(makeApp());

    // A device-only token identifies no owner, so there is no list to give.
    const res = await server.request('/device/list', { headers: APP_ONLY });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidAuthMethodException');
  });
});
