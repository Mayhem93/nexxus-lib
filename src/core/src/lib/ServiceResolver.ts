import {
  NexxusBaseService,
  NexxusConstructableServiceClass,
  NexxusFactoryServiceClass
} from './BaseService';
import { InvalidConfigException } from './Exceptions';

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

/**
 * Require function anchored at the app's launch directory. Dynamic imports
 * inside library code otherwise resolve from the library's own file location
 * (in the workspace tree), which never reaches the app's `node_modules`
 * where its declared adapter packages actually live. Anchoring to the cwd's
 * fake `package.json` path makes Node walk `node_modules` from there.
 */
const requireFromApp = createRequire(path.join(process.cwd(), 'package.json'));

/**
 * A genuine dynamic `import()` that survives TypeScript's CommonJS emit.
 *
 * Compiled with `module: commonjs`, a plain `import(x)` expression is rewritten
 * to `Promise.resolve(x).then(s => require(s))` — and `require()` can't take the
 * `file://` URL we hand it below, so it throws "Cannot find module 'file:///…'".
 * Routing the call through the Function constructor hides the `import` from the
 * compiler, so the emitted CJS keeps a real `import()`. Real `import()` works
 * from inside CommonJS in Node and accepts file URLs for BOTH CJS and ESM
 * targets — which is what `pathToFileURL` produces (and what a Windows absolute
 * path REQUIRES, since a bare `D:\…` path isn't a valid import specifier).
 */
const dynamicImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string
) => Promise<any>;

/**
 * Loads the module for `configuredName` (a bare package specifier) from the
 * app's install tree, then hands back the module object. Works for both
 * CJS and ESM packages: `require.resolve` gives us the absolute path, and
 * dynamic `import()` accepts file URLs for both formats.
 *
 * Shared by the service resolvers below and by ConfigManager's custom
 * config-provider loading — both need resolution anchored to the app's
 * install tree rather than the library's own location.
 */
export function loadPackage(configuredName: string): Promise<any> {
  let resolvedPath: string;

  try {
    resolvedPath = requireFromApp.resolve(configuredName);
  } catch (e) {
    throw new InvalidConfigException(
      `Package "${configuredName}" could not be resolved — make sure it's installed in your deployment. Underlying error: ${(e as Error).message}`
    );
  }

  return dynamicImport(pathToFileURL(resolvedPath).href);
}

/**
 * Runtime sanity check — the loaded class must extend `NexxusBaseService`.
 * Falls back to a clear error if a package returns something unexpected
 * (a plain function, a data object, etc.).
 */
function assertNexxusService(cls: unknown, configuredName: string): void {
  if (typeof cls !== 'function' || !((cls as { prototype: unknown }).prototype instanceof NexxusBaseService)) {
    throw new InvalidConfigException(
      `Class resolved from "${configuredName}" does not extend NexxusBaseService. Make sure the adapter extends NexxusBaseService.`
    );
  }
}

/**
 * Extracts the class the caller wants from a dynamically-loaded module.
 * Convention for external adapter packages: default-export the class (or
 * `module.exports = Cls` for legacy CJS). No `export` field is honoured —
 * Nexxus adapters are Nexxus-specific and there's no reason to hide the
 * class behind a named export.
 */
function pickDefaultExport(mod: any, configuredName: string): unknown {
  if (typeof mod.default === 'function') {
    return mod.default;
  }

  // CJS/ESM interop "double default": a TSC/Babel-compiled `export default
  // class` becomes `exports.default = Cls` with `__esModule` set. import()
  // makes the synthetic ESM default the whole module.exports object, so the
  // real class sits one level down at `.default.default`.
  if (typeof mod.default?.default === 'function') {
    return mod.default.default;
  }

  if (typeof mod === 'function') {
    return mod;
  }

  throw new InvalidConfigException(
    `Package "${configuredName}" does not default-export a class. Nexxus adapters must default-export the adapter class itself.`
  );
}

/**
 * Resolves a config-declared service to a **constructable** class — one the
 * bootstrap will instantiate via `new Cls(services)`.
 *
 *   1. If `configuredName` is in `builtins`, that class is returned directly
 *      (fast path — no I/O, no dynamic import). Callers pass their known
 *      static-imported builtins here.
 *   2. Otherwise the name is treated as an npm package specifier and loaded
 *      via dynamic import against the app's install tree.
 *
 * Used by `NexxusApi.resolveConstructableService` and
 * `NexxusBaseWorker.resolveConstructableService` — the host classes provide
 * their own builtin maps.
 */
export async function resolveConstructableServiceClass(
  configuredName: string,
  builtins: Record<string, NexxusConstructableServiceClass>
): Promise<NexxusConstructableServiceClass> {
  if (configuredName in builtins) {
    return builtins[configuredName];
  }

  const mod = await loadPackage(configuredName);
  const cls = pickDefaultExport(mod, configuredName);

  assertNexxusService(cls, configuredName);

  return cls as NexxusConstructableServiceClass;
}

/**
 * Same as `resolveConstructableServiceClass` but for services that expose an
 * async `static create(services)` factory. Runtime-checks the class actually
 * has `create` before returning, so misconfigurations surface here instead
 * of blowing up at bootstrap time.
 */
export async function resolveFactoryServiceClass(
  configuredName: string,
  builtins: Record<string, NexxusFactoryServiceClass>
): Promise<NexxusFactoryServiceClass> {
  if (configuredName in builtins) {
    return builtins[configuredName];
  }

  const mod = await loadPackage(configuredName);
  const cls = pickDefaultExport(mod, configuredName);

  assertNexxusService(cls, configuredName);

  if (typeof (cls as { create?: unknown }).create !== 'function') {
    throw new InvalidConfigException(
      `Class resolved from "${configuredName}" does not expose a static create() method — required for factory-style services.`
    );
  }

  return cls as NexxusFactoryServiceClass;
}
