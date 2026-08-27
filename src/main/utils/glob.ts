/**
 * A small glob-to-RegExp compiler covering the subset TraceDeck needs: architecture rule
 * patterns and user exclude patterns.
 *
 * Supported syntax:
 *   **   matches any number of path segments, including none
 *   *    matches any run of characters within a single segment
 *   ?    matches exactly one character within a segment
 *   {a,b} matches either alternative
 *
 * Paths are always compared in posix form (forward slashes), so a pattern written on one
 * platform behaves identically on another.
 */

const REGEXP_SPECIALS = /[.+^$()|[\]]/g;

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export class GlobSyntaxError extends Error {
  constructor(pattern: string, reason: string) {
    super(`Invalid pattern "${pattern}": ${reason}`);
    this.name = 'GlobSyntaxError';
  }
}

export function globToRegExp(pattern: string): RegExp {
  const normalised = toPosixPath(pattern).trim();
  if (normalised.length === 0) {
    throw new GlobSyntaxError(pattern, 'pattern is empty');
  }

  let source = '';
  let index = 0;
  let braceDepth = 0;

  while (index < normalised.length) {
    const char = normalised[index] as string;

    if (char === '*') {
      const isDoubleStar = normalised[index + 1] === '*';
      if (isDoubleStar) {
        // `a/**/b` must also match `a/b`, so the separator is absorbed into the wildcard.
        if (normalised[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 3;
        } else {
          source += '.*';
          index += 2;
        }
      } else {
        source += '[^/]*';
        index += 1;
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      source += '(?:';
      index += 1;
      continue;
    }

    if (char === '}') {
      if (braceDepth === 0) throw new GlobSyntaxError(pattern, 'unmatched "}"');
      braceDepth -= 1;
      source += ')';
      index += 1;
      continue;
    }

    if (char === ',' && braceDepth > 0) {
      source += '|';
      index += 1;
      continue;
    }

    source += char.replace(REGEXP_SPECIALS, '\\$&');
    index += 1;
  }

  if (braceDepth > 0) throw new GlobSyntaxError(pattern, 'unmatched "{"');

  return new RegExp(`^${source}$`);
}

export interface GlobMatcher {
  pattern: string;
  test: (relativePath: string) => boolean;
}

export function createGlobMatcher(pattern: string): GlobMatcher {
  const regexp = globToRegExp(pattern);
  return {
    pattern,
    test: (relativePath: string) => regexp.test(toPosixPath(relativePath)),
  };
}

export function createGlobMatchers(patterns: readonly string[]): GlobMatcher[] {
  return patterns.map(createGlobMatcher);
}

export function matchesAny(matchers: readonly GlobMatcher[], relativePath: string): boolean {
  return matchers.some((matcher) => matcher.test(relativePath));
}

/** Validates a pattern for the rule editor without throwing. */
export function validateGlob(pattern: string): { valid: true } | { valid: false; error: string } {
  try {
    globToRegExp(pattern);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Invalid pattern' };
  }
}
