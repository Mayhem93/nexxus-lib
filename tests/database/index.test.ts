/**
 * Ordered manifest for the `database` package. The @elastic/elasticsearch mock
 * is registered HERE (hoisted above suite imports) as a PARTIAL mock: it keeps
 * the real `errors.*` classes (so the adapter's instanceof checks work against
 * errors thrown in tests) and only swaps `Client` for the in-memory fake.
 */
import { vi } from 'vitest';

vi.mock('@elastic/elasticsearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@elastic/elasticsearch')>();
  const { FakeEsClient } = await import('./esFake');

  return { ...actual, Client: FakeEsClient };
});

import './Exceptions';
import './Bootstrapper';
import './ElasticsearchDb';
