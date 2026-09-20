import { describe, it, expect } from 'vitest';
import {
  loadPackage,
  pickDefaultExport,
  assertNexxusService,
  resolveConstructableServiceClass,
  resolveFactoryServiceClass,
  NexxusBaseService
} from '@mayhem93/nexxus-core-lib';

/**
 * NOTE: ServiceResolver loads external packages via a `new Function('return
 * import(x)')` hack (so TypeScript's CommonJS emit doesn't rewrite `import()`
 * into `require()`). That hack throws "A dynamic import callback was not
 * specified" inside Vitest's module runner, so `loadPackage`'s import step —
 * and the resolvers' external-package orchestration downstream of it — cannot
 * be exercised here. To keep the real logic covered, the two pure helpers
 * (`pickDefaultExport`, `assertNexxusService`) are exported and tested directly;
 * this also sidesteps the cross-instance `instanceof` problem, since an in-test
 * subclass extends the same (aliased, source) NexxusBaseService the helper checks.
 */

describe('loadPackage', () => {
  it('throws InvalidConfigException for an unresolvable specifier', () => {
    // Synchronous throw, before the (Vitest-incompatible) dynamic import.
    expect(() => loadPackage('this-package-does-not-exist-xyz'))
      .toThrow(/could not be resolved/);
  });
});

describe('pickDefaultExport', () => {
  it('returns an ESM-style default export', () => {
    const cls = class Foo {};

    expect(pickDefaultExport({ default: cls }, 'pkg')).toBe(cls);
  });

  it('unwraps a CJS/ESM double-default (.default.default)', () => {
    const cls = class Foo {};

    expect(pickDefaultExport({ default: { default: cls } }, 'pkg')).toBe(cls);
  });

  it('returns the module itself when it is a bare function (legacy CJS)', () => {
    const cls = class Foo {};

    expect(pickDefaultExport(cls, 'pkg')).toBe(cls);
  });

  it('throws when there is no default-exported class', () => {
    expect(() => pickDefaultExport({ notAClass: true }, 'pkg'))
      .toThrow(/does not default-export a class/);
  });
});

describe('assertNexxusService', () => {
  it('accepts a class that extends NexxusBaseService', () => {
    class MyAdapter extends NexxusBaseService {}

    expect(() => assertNexxusService(MyAdapter, 'pkg')).not.toThrow();
  });

  it('rejects a class that does not extend NexxusBaseService', () => {
    expect(() => assertNexxusService(class Foo {}, 'pkg'))
      .toThrow(/does not extend NexxusBaseService/);
  });

  it('rejects a non-function value', () => {
    expect(() => assertNexxusService({}, 'pkg'))
      .toThrow(/does not extend NexxusBaseService/);
  });
});

describe('resolveConstructableServiceClass', () => {
  it('returns a builtin directly without any I/O', async () => {
    class Builtin {}

    expect(await resolveConstructableServiceClass('mem', { mem: Builtin as never })).toBe(Builtin);
  });
});

describe('resolveFactoryServiceClass', () => {
  it('returns a builtin directly without any I/O', async () => {
    class Builtin { static create() { /* factory */ } }

    expect(await resolveFactoryServiceClass('mem', { mem: Builtin as never })).toBe(Builtin);
  });
});
