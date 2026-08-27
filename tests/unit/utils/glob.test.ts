import { describe, expect, it } from 'vitest';
import { createGlobMatcher, globToRegExp, toPosixPath, validateGlob } from '@main/utils/glob';

function matches(pattern: string, path: string): boolean {
  return createGlobMatcher(pattern).test(path);
}

describe('globToRegExp', () => {
  it('matches a single segment with *', () => {
    expect(matches('src/*.ts', 'src/app.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/nested/app.ts')).toBe(false);
  });

  it('matches across segments with **', () => {
    expect(matches('src/**', 'src/a.ts')).toBe(true);
    expect(matches('src/**', 'src/deep/nested/a.ts')).toBe(true);
    expect(matches('src/**', 'other/a.ts')).toBe(false);
  });

  it('treats a/**/b as also matching a/b', () => {
    expect(matches('src/**/index.ts', 'src/index.ts')).toBe(true);
    expect(matches('src/**/index.ts', 'src/components/index.ts')).toBe(true);
  });

  it('matches exactly one character with ?', () => {
    expect(matches('src/a?.ts', 'src/ab.ts')).toBe(true);
    expect(matches('src/a?.ts', 'src/abc.ts')).toBe(false);
  });

  it('supports brace alternatives', () => {
    expect(matches('src/**/*.{ts,tsx}', 'src/a.ts')).toBe(true);
    expect(matches('src/**/*.{ts,tsx}', 'src/a.tsx')).toBe(true);
    expect(matches('src/**/*.{ts,tsx}', 'src/a.js')).toBe(false);
  });

  it('escapes regular-expression metacharacters in literal text', () => {
    expect(matches('src/a.ts', 'src/aXts')).toBe(false);
    expect(matches('src/(x)/a.ts', 'src/(x)/a.ts')).toBe(true);
  });

  it('normalises Windows separators before matching', () => {
    expect(matches('src/**', toPosixPath('src\\components\\Button.tsx'))).toBe(true);
    expect(createGlobMatcher('src/**').test('src\\components\\Button.tsx')).toBe(true);
  });

  it('rejects malformed patterns', () => {
    expect(() => globToRegExp('src/{a,b')).toThrow(/unmatched/);
    expect(() => globToRegExp('   ')).toThrow(/empty/);
    expect(validateGlob('src/{a,b')).toEqual({ valid: false, error: expect.any(String) });
    expect(validateGlob('src/**')).toEqual({ valid: true });
  });
});
