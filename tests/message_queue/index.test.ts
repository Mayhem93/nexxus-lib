/**
 * Ordered manifest for the `message_queue` package's unit suites, bottom-up by
 * dependency (see the note in tests/core/index.test.ts). Only these per-package
 * index.test.ts files are collected by vitest.
 *
 * The amqplib mock is registered HERE (hoisted above the suite imports) so it
 * wins before the mq barrel transitively loads the real amqplib during the
 * first suite. The RabbitMq suite imports the same fake to drive it.
 */
import { vi } from 'vitest';

vi.mock('amqplib', async () => {
  const fake = await import('./amqplibFake');

  return { connect: fake.connect };
});

import './Compression';
import './MessageQueueAdapter';
import './RabbitMqBootstrapper';
import './RabbitMq';
