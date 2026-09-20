import { describe, it, expect } from 'vitest';

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

/**
 * `ajv` and `yaml` are dependencies of the `api` PACKAGE, not of the root
 * project — the root's own `ajv` is a transitive copy on the wrong major. A
 * plain `import` from a test file resolves against the root, so both are loaded
 * through a require rooted in `src/api` instead.
 */
const apiRequire = createRequire(path.join(process.cwd(), 'src/api/'));
const Ajv2020 = apiRequire('ajv/dist/2020').default;
const YAML = apiRequire('yaml');

const FIXTURES = path.join(process.cwd(), 'tests/api/fixtures');

const readJson = (file: string): any => JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8'));

const specPath = path.join(process.cwd(), 'src/api/openapi.yaml');
const specSource = readFileSync(specPath, 'utf8');

/**
 * Compile a validator for OpenAPI 3.1 documents.
 *
 * The three schemas are VENDORED (verbatim copies of the published artefacts)
 * so the suite stays offline and deterministic — a unit test that reaches
 * spec.openapis.org fails whenever the network or that host does.
 *
 * The one edit: the document schema defines Schema Objects with
 * `$dynamicAnchor: "meta"` and reaches them from four places via
 * `$dynamicRef: "#meta"`. AJV cannot resolve a `$dynamicAnchor` that is not at
 * a schema resource's root, so every Schema Object ends up UNEVALUATED — and
 * `unevaluatedProperties: false` then rejects perfectly ordinary things like
 * `{ type: 'object' }`. Rewriting those four references to a static `$ref` at
 * the dialect makes the dialect apply properly; it is the same workaround other
 * validators use. Patched here rather than in the vendored file so the copy on
 * disk stays a faithful reproduction of what the OpenAPI Initiative publishes.
 */
function compileOpenApiValidator(): (doc: unknown) => boolean {
  const dialect = readJson('openapi-3.1-dialect.json');
  const meta = readJson('openapi-3.1-meta.json');
  const schemaSource = readFileSync(path.join(FIXTURES, 'openapi-3.1-schema.json'), 'utf8');
  const patched = JSON.parse(schemaSource.replaceAll('"$dynamicRef": "#meta"', `"$ref": "${dialect.$id}"`));

  // `validateFormats: false` — the OpenAPI schema leans on formats AJV doesn't
  // ship (`uri-reference`, `media-range`). Without `ajv-formats` they would be
  // ignored with a warning per occurrence; structure is what this test is for.
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });

  ajv.addSchema(meta);
  ajv.addSchema(dialect);

  return ajv.compile(patched);
}

const validate = compileOpenApiValidator();
const spec = YAML.parse(specSource);

describe('openapi.yaml', () => {
  it('is a valid OpenAPI 3.1 document', () => {
    const valid = validate(spec);

    // Print the offending paths rather than a boolean — a schema violation in a
    // 900-line document is otherwise a hunt.
    expect(
      valid ? [] : (validate as unknown as { errors: any[] }).errors.map(e => `${e.instancePath}: ${e.message}`),
    ).toEqual([]);
  });

  it('declares the version the project targets', () => {
    expect(spec.openapi).toBe('3.1.1');
  });

  /**
   * The validator itself has to be proven to bite. `unevaluatedProperties:
   * false` throughout the OpenAPI schema is what catches typos, and it is worth
   * knowing it survived the `$dynamicRef` patch above — a mis-applied patch
   * would leave a validator that accepts anything.
   */
  it('rejects a document with a typo in an operation', () => {
    const typo = structuredClone(spec);

    typo.paths['/user/me'].get.responsez = {};

    expect(validate(typo)).toBe(false);
  });

  it('rejects a document with a malformed schema object', () => {
    const broken = structuredClone(spec);

    broken.components.schemas.Device.type = 'not-a-json-schema-type';

    expect(validate(broken)).toBe(false);
  });

  it('keeps its version in step with the package', () => {
    // The published spec ships inside the package; a stale `info.version` would
    // describe a release it did not come from.
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'src/api/package.json'), 'utf8'));

    expect(spec.info.version).toBe(pkg.version);
  });

  it('is shipped by the package', () => {
    // The nexxus-api docs build reads this straight out of node_modules, so it
    // has to be in `files` or it never leaves this repo.
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'src/api/package.json'), 'utf8'));

    expect(pkg.files).toContain('openapi.yaml');
  });

  /**
   * The OpenAPI schema is structural: it checks that a `$ref` is a string, not
   * that anything is there. A typo'd component reference is therefore invisible
   * to the validator above and shows up as an empty section in the rendered
   * docs — which is exactly the kind of thing nobody notices.
   */
  it('has no dangling internal $ref', () => {
    const dangling: string[] = [];

    const resolve = (pointer: string): boolean =>
      pointer.slice(2).split('/').reduce<any>(
        (node, segment) => node?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')],
        spec,
      ) !== undefined;

    const walk = (node: unknown, at: string): void => {
      if (!node || typeof node !== 'object') {
        return;
      }

      for (const [ key, value ] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string' && value.startsWith('#/') && !resolve(value)) {
          dangling.push(`${at} → ${value}`);
        }

        walk(value, `${at}/${key}`);
      }
    };

    walk(spec, '');

    expect(dangling).toEqual([]);
  });

  /**
   * Not a route-coverage test — that comes later, walking the Express router.
   * This is the cheap half: the operations the framework exposes are a closed
   * set, and a route added without a line here is the mistake worth catching.
   */
  it('documents every route the API registers', () => {
    const documented = Object.entries(spec.paths).flatMap(([ p, ops ]) =>
      Object.keys(ops as object)
        .filter(k => [ 'get', 'post', 'put', 'delete', 'patch' ].includes(k))
        .map(method => `${method.toUpperCase()} ${p}`));

    expect(documented.sort()).toEqual([
      'DELETE /model/{id}',
      'DELETE /subscription',
      'GET /',
      'GET /auth/{strategy}/callback',
      'GET /device',
      'GET /device/list',
      'GET /model/{id}',
      'GET /user/me',
      'POST /auth/{strategy}',
      'POST /device/register',
      'POST /model',
      'POST /model/count',
      'POST /model/{type}/search',
      'POST /subscription',
      'POST /user/register',
      'PUT /device',
      'PUT /model/{id}',
      'PUT /user',
    ]);
  });
});
