import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import OrderedSequencer from './tests/sequencer';

const fromRoot = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve first-party packages to their TypeScript SOURCE (not the built
    // dist) so tests run against current code with no rebuild, and every
    // import shares ONE module instance — which keeps the cross-package
    // `instanceof` guards (API/worker constructors) valid under test.
    alias: {
      '@mayhem93/nexxus-core-lib':          fromRoot('./src/core/src/index.ts'),
      '@mayhem93/nexxus-database-lib':      fromRoot('./src/database/src/index.ts'),
      '@mayhem93/nexxus-redis':             fromRoot('./src/redis/src/index.ts'),
      '@mayhem93/nexxus-message-queue-lib': fromRoot('./src/message_queue/src/index.ts'),
      '@mayhem93/nexxus-api-lib':           fromRoot('./src/api/src/index.ts'),
      '@mayhem93/nexxus-worker-lib':        fromRoot('./src/worker/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    // Only the per-package manifest files are collected; each imports its unit
    // suites (plain .ts) in dependency order. `*` (one level) keeps it to
    // tests/<package>/index.test.ts.
    include: ['tests/*/index.test.ts'],
    // Unit tests aren't CPU-bound — run serially for deterministic output.
    fileParallelism: false,
    // Cross-package order: core → adapters → consumers (see tests/sequencer.ts).
    sequence: {
      sequencer: OrderedSequencer,
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html'],
      // Measure the packages' source, not builds, schemas, or the tests.
      include: ['src/*/src/**/*.ts'],
      exclude: ['**/dist-*/**', '**/*.d.ts', 'src/*/src/schemas/**'],
    },
  },
});
