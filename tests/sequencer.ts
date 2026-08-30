import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';

/**
 * Runs the per-package test files in dependency order — `core` first, then the
 * mid-tier adapters, then the consumers. This only affects the CROSS-package
 * order of the `index.test.ts` files; intra-package order comes from each
 * index's import order. Anything unrecognized sorts last.
 */
const PACKAGE_ORDER = ['core', 'database', 'message_queue', 'redis', 'api', 'worker'];

export default class OrderedSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const rank = (spec: TestSpecification): number => {
      const path = spec.moduleId.replace(/\\/g, '/');
      const index = PACKAGE_ORDER.findIndex(pkg => path.includes(`/tests/${pkg}/`));

      return index === -1 ? PACKAGE_ORDER.length : index;
    };

    return [...files].sort((a, b) => rank(a) - rank(b));
  }
}
