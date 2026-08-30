import { describe, it, expect } from 'vitest';
import { isBuiltinModel, isAppScopedBuiltinModel } from '@mayhem93/nexxus-core-lib';

describe('BuiltinSchemas predicates', () => {
  describe('isBuiltinModel', () => {
    it('is true for every builtin model type', () => {
      for (const type of ['user', 'application', 'setting', 'acl']) {
        expect(isBuiltinModel(type)).toBe(true);
      }
    });

    it('is false for an app model or unknown name', () => {
      expect(isBuiltinModel('runs')).toBe(false);
      expect(isBuiltinModel('')).toBe(false);
    });
  });

  describe('isAppScopedBuiltinModel', () => {
    it('is true for the app-scoped builtins (user, acl)', () => {
      expect(isAppScopedBuiltinModel('user')).toBe(true);
      expect(isAppScopedBuiltinModel('acl')).toBe(true);
    });

    it('is false for the deployment-scoped builtins (application, setting)', () => {
      expect(isAppScopedBuiltinModel('application')).toBe(false);
      expect(isAppScopedBuiltinModel('setting')).toBe(false);
    });

    it('is false for an app model or unknown name', () => {
      expect(isAppScopedBuiltinModel('runs')).toBe(false);
    });
  });
});
