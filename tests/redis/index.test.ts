/**
 * Ordered manifest for the `redis` package's unit suites, bottom-up by
 * dependency. The `redis` module mock is registered HERE (hoisted above the
 * suite imports) so it wins before the redis barrel transitively loads the real
 * client during the first suite. Only the SERVICE test uses it; model tests
 * inject a stateful FakeRedis via NexxusRedis.instance instead.
 */
import { vi } from 'vitest';

vi.mock('redis', async () => {
  const m = await import('./redisModuleMock');

  return { createClient: m.createClient, createCluster: m.createCluster };
});

import './Exceptions';
import './Redis';
import './Subscription';
import './FieldCache';
import './Device';
