import { describe, it, expect, beforeEach } from 'vitest';

import { NexxusApiModelParams, type NexxusValidatedModelParams } from '../../src/api/src/lib/ModelParams';
import type { NexxusApiRequest } from '../../src/api/src/lib/Api';

import { installApiStatics, seedApp, makeApp, makeAuthApp } from './harness';

/** The only part of a request these functions read. */
const reqFor = (appId = 'app1'): NexxusApiRequest =>
  ({ headers: { 'nxx-app-id': appId } }) as unknown as NexxusApiRequest;

/** An app whose `runs` model has something filterable to build queries against. */
const schema = {
  runs: {
    fields: {
      note:     { type: 'string', required: false, filterable: true },
      distance: { type: 'int', required: false, filterable: true },
      secret:   { type: 'string', required: false },
    },
  },
};

const validate = (body: Record<string, unknown>, model = 'runs'): NexxusValidatedModelParams =>
  NexxusApiModelParams.validate(reqFor(), body, model);

describe('NexxusApiModelParams.validate — model resolution', () => {
  beforeEach(() => {
    installApiStatics();
    seedApp(makeApp({ schema }));
  });

  it('resolves the application and model from the request', () => {
    const out = validate({});

    expect(out.appId).toBe('app1');
    expect(out.model).toBe('runs');
    expect(out.app.getData().id).toBe('app1');
  });

  it('rejects a missing or non-string model', () => {
    // Called directly rather than through the `validate` helper: its default
    // parameter would substitute a real model name for the undefined case.
    for (const model of [ '', undefined, null, 42 ]) {
      expect(() => NexxusApiModelParams.validate(reqFor(), {}, model as never))
        .toThrow(/Invalid model parameter/);
    }
  });

  it('rejects a model the application schema does not declare', () => {
    expect(() => validate({}, 'ghost')).toThrow(/Model "ghost" not found in application "app1"/);
  });

  it('leaves id, userId and filter undefined when the body carries none', () => {
    expect(validate({})).toMatchObject({ id: undefined, userId: undefined, filter: undefined });
  });
});

describe('NexxusApiModelParams.validate — id and userId', () => {
  beforeEach(() => {
    installApiStatics();
    seedApp(makeAuthApp({ schema }));
  });

  it('accepts a string id', () => {
    expect(validate({ id: 'm1' }).id).toBe('m1');
  });

  it('rejects a non-string id', () => {
    expect(() => validate({ id: 42 })).toThrow(/Invalid modelId parameter/);
  });

  it('accepts a string userId on an application with authentication', () => {
    expect(validate({ userId: 'u1' }).userId).toBe('u1');
  });

  it('rejects a non-string userId', () => {
    expect(() => validate({ userId: 42 })).toThrow(/Invalid userId parameter/);
  });

  it('rejects id and userId together', () => {
    // Both narrow the result set, and an id already identifies exactly one
    // object — combining them is a request the caller didn't mean to make.
    expect(() => validate({ id: 'm1', userId: 'u1' })).toThrow(/Redundant modelId and userId parameters/);
  });

  it('rejects userId on an application WITHOUT authentication', () => {
    installApiStatics();
    seedApp(makeApp({ schema }));

    expect(() => validate({ userId: 'u1' }))
      .toThrow(/userId parameter cannot be used when authentication is disabled/);
  });
});

describe('NexxusApiModelParams.validate — filter', () => {
  beforeEach(() => {
    installApiStatics();
    seedApp(makeApp({ schema }));
  });

  it('materializes a valid filter into a NexxusFilterQuery', () => {
    const out = validate({ filter: { note: 'hi' } });

    expect(out.filter).toBeDefined();
    expect(out.filter!.test({ note: 'hi' })).toBe(true);
    expect(out.filter!.test({ note: 'bye' })).toBe(false);
  });

  it('rejects a non-object filter', () => {
    expect(() => validate({ filter: 'note=hi' })).toThrow(/Invalid filter parameter/);
  });

  /**
   * Core throws `InvalidQueryFilterException`, which is a `NexxusException` but
   * not a `NexxusApiException` — so it has no status code and the error
   * middleware would render it as a 500. A filter naming a field that isn't
   * filterable is the CALLER's mistake, so it has to become a 400.
   */
  it('restates a core filter rejection as an API parameter error', () => {
    expect(() => validate({ filter: { ghost: 'x' } })).toThrow(/Invalid filter parameter: /);
    expect(() => validate({ filter: { secret: 'x' } })).toThrow(/Invalid filter parameter: /);
  });
});

describe('NexxusApiModelParams.toDatabaseFilter', () => {
  beforeEach(() => {
    installApiStatics();
    seedApp(makeAuthApp({ schema }));
  });

  it('returns undefined when the caller supplied nothing to narrow by', () => {
    // Lets the route skip building a query object entirely.
    expect(NexxusApiModelParams.toDatabaseFilter(validate({}), undefined)).toBeUndefined();
  });

  it('folds a bare id into the filter', () => {
    const out = NexxusApiModelParams.toDatabaseFilter(validate({ id: 'm1' }), undefined)!;

    expect(out.test({ id: 'm1' })).toBe(true);
    expect(out.test({ id: 'm2' })).toBe(false);
  });

  it('folds a bare userId into the filter', () => {
    const out = NexxusApiModelParams.toDatabaseFilter(validate({ userId: 'u1' }), undefined)!;

    expect(out.test({ userId: 'u1' })).toBe(true);
    expect(out.test({ userId: 'u2' })).toBe(false);
  });

  it('combines the caller filter with the id', () => {
    const validated = validate({ id: 'm1', filter: { note: 'hi' } });
    const out = NexxusApiModelParams.toDatabaseFilter(validated, { note: 'hi' })!;

    expect(out.test({ id: 'm1', note: 'hi' })).toBe(true);
    expect(out.test({ id: 'm1', note: 'bye' })).toBe(false);
    expect(out.test({ id: 'm2', note: 'hi' })).toBe(false);
  });

  it('does not mutate the caller filter it was handed', () => {
    // It's `structuredClone`d because the SAME raw filter object is also used
    // to build the subscription filter — folding id/userId into it in place
    // would silently widen what a stored subscription matches.
    const raw = { note: 'hi' };

    NexxusApiModelParams.toDatabaseFilter(validate({ id: 'm1', filter: raw }), raw);

    expect(raw).toEqual({ note: 'hi' });
  });

  it('leaves the validated subscription filter untouched', () => {
    const raw = { note: 'hi' };
    const validated = validate({ id: 'm1', filter: raw });

    NexxusApiModelParams.toDatabaseFilter(validated, raw);

    // The subscription filter must keep matching only the fields the client
    // cares about, not the framework-injected id.
    expect(validated.filter!.test({ note: 'hi' })).toBe(true);
  });

  describe('ACL constraint', () => {
    it('returns the constraint alone when the caller narrowed by nothing', () => {
      const out = NexxusApiModelParams.toDatabaseFilter(validate({}), undefined, { userId: 'owner' })!;

      expect(out.test({ userId: 'owner' })).toBe(true);
      expect(out.test({ userId: 'someone-else' })).toBe(false);
    });

    it('ANDs the constraint with the caller filter so it can only narrow', () => {
      // The conjunction is the security property: a client filter must never be
      // able to widen the row scope an ACL grants.
      const validated = validate({ filter: { note: 'hi' } });
      const out = NexxusApiModelParams.toDatabaseFilter(validated, { note: 'hi' }, { userId: 'owner' })!;

      expect(out.test({ note: 'hi', userId: 'owner' })).toBe(true);
      expect(out.test({ note: 'hi', userId: 'someone-else' })).toBe(false);
      expect(out.test({ note: 'bye', userId: 'owner' })).toBe(false);
    });

    it('cannot be escaped by an $or in the caller filter', () => {
      const raw = { $or: [ { note: 'hi' }, { note: 'bye' } ] };
      const validated = validate({ filter: raw });
      const out = NexxusApiModelParams.toDatabaseFilter(validated, raw, { userId: 'owner' })!;

      // Either branch of the client's $or still has to clear the constraint.
      expect(out.test({ note: 'bye', userId: 'owner' })).toBe(true);
      expect(out.test({ note: 'bye', userId: 'someone-else' })).toBe(false);
    });

    it('ANDs the constraint with a folded id too', () => {
      const out = NexxusApiModelParams.toDatabaseFilter(validate({ id: 'm1' }), undefined, { userId: 'owner' })!;

      expect(out.test({ id: 'm1', userId: 'owner' })).toBe(true);
      expect(out.test({ id: 'm1', userId: 'someone-else' })).toBe(false);
    });

    it('restates a core rejection of the combined filter as a 400', () => {
      expect(() => NexxusApiModelParams.toDatabaseFilter(validate({}), undefined, { ghost: 'x' }))
        .toThrow(/Invalid filter parameter: /);
    });

    it('lets a non-filter failure propagate unchanged', () => {
      // Only a filter rejection becomes "invalid filter parameter". Anything
      // else — here, a model the schema doesn't declare, which `validate` would
      // normally have caught — is a fault on our side, and relabelling it as
      // the caller's bad input would send a 400 for a 500-shaped problem.
      const validated = { ...validate({}), model: 'ghost' };

      expect(() => NexxusApiModelParams.toDatabaseFilter(validated, { note: 'hi' }))
        .toThrow(/Unknown app model type: ghost/);
    });
  });
});
