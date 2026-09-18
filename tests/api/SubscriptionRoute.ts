import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  NexxusToken, NexxusAppModel, NexxusAclManager, NexxusAclRole, DEFAULT_ACL_ROLE_ID,
  type INexxusAclRole, type NexxusAclStatement, type NexxusApplication,
} from '@mayhem93/nexxus-core-lib';
import { NexxusDevice } from '@mayhem93/nexxus-redis';

import SubscriptionRoute from '../../src/api/src/lib/routes/Subscription';

import {
  installApiStatics, seedApp, makeApp, makeAuthApp, dbState,
  startTestServer, type TestServer,
} from './harness';
import { installFakeRedis } from '../redis/helpers';

const USER = {
  id: 'u1', username: 'ann', userType: 'default',
  authProviders: [ 'local' ], details: {}, appId: 'app1',
} as never;

const SCHEMA = {
  runs: {
    fields: {
      note:  { type: 'string', required: false, filterable: true },
      owner: { type: 'string', required: false, filterable: true, acl: true },
    },
  },
  reports: { subscribable: false, fields: { note: { type: 'string', required: false } } },
};

let server: TestServer;
let app: NexxusApplication;

const APP_ONLY: Record<string, string> = { 'nxx-app-id': 'app1' };

function as(user?: unknown, deviceId = 'd1'): Record<string, string> {
  return {
    'nxx-app-id': 'app1',
    authorization: `Bearer ${NexxusToken.issue(app, { appId: 'app1', deviceId, user: user as never })}`,
  };
}

const send = (method: string, body: unknown, headers: Record<string, string>) =>
  server.request('/subscription', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const subscribe = (body: unknown, headers = as()) => send('POST', body, headers);
const unsubscribe = (body: unknown, headers = as()) => send('DELETE', body, headers);

/** A device that is connected to a transport — required to hold subscriptions. */
async function connectedDevice(id = 'd1', userId?: string): Promise<void> {
  const device = new NexxusDevice({ id, appId: 'app1', userId, name: 'Phone', subscriptions: [] });

  await device.save();
  await NexxusDevice.update(id, { transport: 'websockets-transport_0', type: 'volatile', status: 'online' });
}

async function serve(application: NexxusApplication): Promise<void> {
  app = seedApp(application);
  server = await startTestServer(expressApp => { new SubscriptionRoute(expressApp); });
}

function aclApp(statements: NexxusAclStatement[]): NexxusApplication {
  const application = makeAuthApp({
    schema: SCHEMA,
    auth: { strategies: { local: {} }, userDetailSchema: { default: {} }, acl: true },
  });

  application.setRoleManagers([ new NexxusAclManager(new NexxusAclRole({
    id: DEFAULT_ACL_ROLE_ID, type: 'acl', appId: 'app1', statements: JSON.stringify(statements),
  } as INexxusAclRole)) ]);

  return application;
}

const ALLOW_OWN: NexxusAclStatement[] = [ {
  effect: 'Allow', action: [ '*' ], resource: [ 'runs' ],
  condition: { StringEquals: { userId: [ '$nxx:userId' ] } },
} ];

describe('POST /subscription', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('records the subscription and returns the channel with the first page', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();
    dbState.searchResult = [ new NexxusAppModel({ id: 'm1', type: 'runs', appId: 'app1' } as never, null) ];

    const res = await subscribe({ model: 'runs' });

    expect(res.status).toBe(200);
    expect(res.body.data.channelId).toEqual(expect.any(String));
    expect(res.body.data.items).toHaveLength(1);

    const device = await NexxusDevice.get('d1', true);

    expect(device.getValue().subscriptions).toHaveLength(1);
  });

  it('asks the database for a consistent first page', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    await subscribe({ model: 'runs' });

    // The subscription was just recorded; the initial page has to reflect any
    // in-flight writes or the client starts out of sync.
    expect(dbState.searchCalls[0].databaseSpecific).toEqual({ forceRefresh: true });
  });

  it('refuses a model the application declares non-subscribable', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    const res = await subscribe({ model: 'reports' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/use the search endpoint/);
  });

  it('404s when the calling device no longer exists', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    const res = await subscribe({ model: 'runs' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NotFoundException');
  });

  it('409s a device that is not connected to a transport', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await new NexxusDevice({ id: 'd1', appId: 'app1', name: 'Phone', subscriptions: [] }).save();

    // Subscriptions are delivered over a transport — recording one for a device
    // with nowhere to send it would accrue state nothing can consume.
    const res = await subscribe({ model: 'runs' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DeviceNotConnectedException');
  });

  it('400s a request carrying no device', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    // A subscription belongs to the calling device, and only a token can
    // identify one — a bare app header gets no further than RequiresDevice,
    // even on an application with no authentication.
    const res = await server.request('/subscription', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...APP_ONLY },
      body: JSON.stringify({ model: 'runs' }),
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/POST \/device\/register/);
  });

  it('applies the application default limit', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    await subscribe({ model: 'runs' });

    expect(dbState.searchCalls[0]).toMatchObject({ limit: 10, offset: 0 });
  });

  it('rejects an out-of-range limit or offset', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    expect((await subscribe({ model: 'runs', limit: 1000 })).status).toBe(400);
    expect((await subscribe({ model: 'runs', limit: 0 })).status).toBe(400);
    expect((await subscribe({ model: 'runs', offset: -1 })).status).toBe(400);
  });

  it('404s an unknown model', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    expect((await subscribe({ model: 'ghost' })).status).toBe(404);
  });

  it('403s when no role allows subscribing', async () => {
    await serve(aclApp([ { effect: 'Allow', action: [ 'write' ], resource: [ 'runs' ] } ]));
    await connectedDevice('d1', 'u1');

    const res = await subscribe({ model: 'runs' }, as(USER));

    expect(res.status).toBe(403);
  });

  /**
   * Folding the ACL constraint into the STORED subscription is what keeps the
   * transport manager ACL-agnostic: it just matches this filter and can never
   * fan a row out to a principal that may not read it.
   */
  it('folds the row constraint into the stored subscription', async () => {
    await serve(aclApp(ALLOW_OWN));
    await connectedDevice('d1', 'u1');

    const unrestricted = await subscribe({ model: 'runs' }, as(USER));

    await server.close();
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    const plain = await subscribe({ model: 'runs' });

    // A constrained subscription is a DIFFERENT channel from an unconstrained
    // one, because the key is derived from the effective filter.
    expect(unrestricted.body.data.channelId).not.toBe(plain.body.data.channelId);
  });

  it('narrows the first page by the row constraint too', async () => {
    await serve(aclApp(ALLOW_OWN));
    await connectedDevice('d1', 'u1');

    await subscribe({ model: 'runs', filter: { note: 'hi' } }, as(USER));

    const filter = dbState.searchCalls[0].filter;

    expect(filter.test({ note: 'hi', userId: 'u1' })).toBe(true);
    expect(filter.test({ note: 'hi', userId: 'u2' })).toBe(false);
  });
});

describe('DELETE /subscription', () => {
  beforeEach(() => {
    installApiStatics();
    installFakeRedis();
  });

  afterEach(async () => { await server.close(); });

  it('removes a subscription created with the same descriptor', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    const created = await subscribe({ model: 'runs', filter: { note: 'hi' } });
    const removed = await unsubscribe({ model: 'runs', filter: { note: 'hi' } });

    expect(removed.status).toBe(200);
    // Same inputs must derive the same key, or a subscription could never be
    // removed by the client that made it.
    expect(removed.body.data.channel).toBe(created.body.data.channelId);
    expect((await NexxusDevice.get('d1', true)).getValue().subscriptions).toHaveLength(0);
  });

  it('404s a subscription the device does not have', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    const res = await unsubscribe({ model: 'runs' });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found on device "d1"/);
  });

  it('does not match a subscription made with a different filter', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    await subscribe({ model: 'runs', filter: { note: 'hi' } });

    expect((await unsubscribe({ model: 'runs', filter: { note: 'bye' } })).status).toBe(404);
  });

  it('reconstructs the ACL-folded filter so a constrained subscription can be removed', async () => {
    await serve(aclApp(ALLOW_OWN));
    await connectedDevice('d1', 'u1');

    const created = await subscribe({ model: 'runs', filter: { note: 'hi' } }, as(USER));
    const removed = await unsubscribe({ model: 'runs', filter: { note: 'hi' } }, as(USER));

    // Unsubscribe must fold the constraint in exactly as subscribe did —
    // otherwise an ACL-scoped subscription is permanent.
    expect(removed.status).toBe(200);
    expect(removed.body.data.channel).toBe(created.body.data.channelId);
  });

  it('refuses a model the application declares non-subscribable', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await connectedDevice();

    const res = await unsubscribe({ model: 'reports' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nothing to unsubscribe from/);
  });

  it('404s when the calling device no longer exists', async () => {
    await serve(makeApp({ schema: SCHEMA }));

    expect((await unsubscribe({ model: 'runs' })).status).toBe(404);
  });

  it('409s a device that is not connected to a transport', async () => {
    await serve(makeApp({ schema: SCHEMA }));
    await new NexxusDevice({ id: 'd1', appId: 'app1', name: 'Phone', subscriptions: [] }).save();

    expect((await unsubscribe({ model: 'runs' })).status).toBe(409);
  });

  it('403s when no role allows subscribing', async () => {
    await serve(aclApp([ { effect: 'Allow', action: [ 'write' ], resource: [ 'runs' ] } ]));
    await connectedDevice('d1', 'u1');

    // Gated by the same permission the subscription required.
    expect((await unsubscribe({ model: 'runs' }, as(USER))).status).toBe(403);
  });
});
