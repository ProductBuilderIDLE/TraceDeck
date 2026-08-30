import { describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  canonicalStringify,
  compareCodePoints,
  stableBy,
} from '@main/services/changeReview/canonical';

describe('change review canonical values', () => {
  it('sorts by Unicode code point without host locale', () => {
    expect(stableBy(['z', 'a', 'ä', '𐀀', '\uE000'], (value) => value)).toEqual([
      'a',
      'z',
      'ä',
      '\uE000',
      '𐀀',
    ]);
    expect(compareCodePoints('a', 'a')).toBe(0);
  });

  it('sorts object keys recursively but preserves semantic array order', () => {
    expect(
      canonicalStringify({
        b: { z: 2, a: 1 },
        a: [
          { second: 2, first: 1 },
          { fourth: 4, third: 3 },
        ],
      }),
    ).toBe(
      '{"a":[{"first":1,"second":2},{"fourth":4,"third":3}],"b":{"a":1,"z":2}}',
    );
    expect(canonicalStringify({ 2: 'two', 10: 'ten' })).toBe('{"10":"ten","2":"two"}');
  });

  it('hashes equivalent key order identically', () => {
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
    expect(canonicalSha256({ values: ['first', 'second'] })).not.toBe(
      canonicalSha256({ values: ['second', 'first'] }),
    );
  });

  it('sorts a copy without mutating the input array', () => {
    const input = [{ path: 'z.ts' }, { path: 'a.ts' }];

    const sorted = stableBy(input, (item) => item.path);

    expect(sorted).toEqual([{ path: 'a.ts' }, { path: 'z.ts' }]);
    expect(input).toEqual([{ path: 'z.ts' }, { path: 'a.ts' }]);
    expect(sorted).not.toBe(input);
  });
});
