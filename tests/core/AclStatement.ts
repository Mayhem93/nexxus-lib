import { describe, it, expect } from 'vitest';
import { NexxusAclGrammar, ACL_ACTIONS } from '@mayhem93/nexxus-core-lib';

describe('NexxusAclGrammar', () => {
  describe('expandActionToken', () => {
    it('expands "*" to every action', () => {
      expect(NexxusAclGrammar.expandActionToken('*')).toEqual(ACL_ACTIONS);
    });

    it('expands "read" to the read actions', () => {
      expect(NexxusAclGrammar.expandActionToken('read')).toEqual(['get', 'search', 'count', 'subscribe']);
    });

    it('expands "write" to the write actions', () => {
      expect(NexxusAclGrammar.expandActionToken('write')).toEqual(['create', 'update', 'delete']);
    });

    it('returns a single-element array for a concrete action', () => {
      expect(NexxusAclGrammar.expandActionToken('create')).toEqual(['create']);
    });

    it('returns null for an unknown token', () => {
      expect(NexxusAclGrammar.expandActionToken('frobnicate')).toBeNull();
    });

    it('is case-sensitive (rejects "READ")', () => {
      expect(NexxusAclGrammar.expandActionToken('READ')).toBeNull();
    });
  });

  describe('expandActions', () => {
    it('unions multiple tokens', () => {
      const result = NexxusAclGrammar.expandActions(['read', 'create']);

      expect([...result].sort()).toEqual(['count', 'create', 'get', 'search', 'subscribe']);
    });

    it('de-duplicates overlapping tokens', () => {
      // "read" already covers "get", so the set stays the four read actions.
      const result = NexxusAclGrammar.expandActions(['read', 'get']);

      expect(result.size).toBe(4);
    });

    it('"*" yields every action', () => {
      expect(NexxusAclGrammar.expandActions(['*']).size).toBe(ACL_ACTIONS.length);
    });

    it('skips unknown tokens without throwing', () => {
      expect([...NexxusAclGrammar.expandActions(['create', 'bogus'])]).toEqual(['create']);
    });

    it('returns an empty set for an empty list', () => {
      expect(NexxusAclGrammar.expandActions([]).size).toBe(0);
    });
  });

  describe('isContextRef', () => {
    it('is true for a $nxx: reference', () => {
      expect(NexxusAclGrammar.isContextRef('$nxx:userId')).toBe(true);
    });

    it('is false for a plain string', () => {
      expect(NexxusAclGrammar.isContextRef('userId')).toBe(false);
    });

    it('is false for a number', () => {
      expect(NexxusAclGrammar.isContextRef(42)).toBe(false);
    });

    it('requires the prefix at the start, not just anywhere', () => {
      expect(NexxusAclGrammar.isContextRef('x$nxx:userId')).toBe(false);
    });
  });

  describe('contextKeyOf', () => {
    it('strips the prefix to yield the bare key', () => {
      expect(NexxusAclGrammar.contextKeyOf('$nxx:userId')).toBe('userId');
      expect(NexxusAclGrammar.contextKeyOf('$nxx:appId')).toBe('appId');
    });
  });

  describe('isEqualityOperator', () => {
    it('is true for the equality operators', () => {
      expect(NexxusAclGrammar.isEqualityOperator('StringEquals')).toBe(true);
      expect(NexxusAclGrammar.isEqualityOperator('NumericEquals')).toBe(true);
    });

    it('is false for the not-equality operators', () => {
      expect(NexxusAclGrammar.isEqualityOperator('StringNotEquals')).toBe(false);
      expect(NexxusAclGrammar.isEqualityOperator('NumericNotEquals')).toBe(false);
    });
  });
});
