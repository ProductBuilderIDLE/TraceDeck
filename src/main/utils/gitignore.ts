import { toPosixPath } from './glob';

/**
 * A pragmatic .gitignore evaluator.
 *
 * It implements the rules that matter for deciding which source files to analyse: negation
 * with `!`, anchoring with a leading or embedded `/`, directory-only patterns ending in `/`,
 * and `**` segments. It deliberately does not reimplement every corner of git's matcher —
 * where behaviour is ambiguous it errs toward *including* a file, because wrongly skipping a
 * source file would silently produce an incomplete graph.
 */

interface IgnoreRule {
  regexp: RegExp;
  negated: boolean;
  directoryOnly: boolean;
}

const REGEXP_SPECIALS = /[.+^$()|[\]{}]/g;

function compilePattern(rawPattern: string): IgnoreRule | null {
  let pattern = rawPattern.trim();
  if (pattern.length === 0 || pattern.startsWith('#')) return null;

  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);

  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) pattern = pattern.slice(0, -1);

  if (pattern.length === 0) return null;

  // A pattern containing a slash anywhere but at the end is anchored to the ignore file's
  // directory; one without is matched against any path segment.
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  let source = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
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

    source += char.replace(REGEXP_SPECIALS, '\\$&');
    index += 1;
  }

  // An ignored directory ignores everything beneath it, hence the optional trailing segment.
  const tail = '(?:/.*)?';
  const head = anchored ? '' : '(?:.*/)?';

  return {
    regexp: new RegExp(`^${head}${source}${tail}$`),
    negated,
    directoryOnly,
  };
}

export class GitignoreMatcher {
  private readonly rules: IgnoreRule[];

  constructor(patterns: readonly string[]) {
    this.rules = patterns
      .map(compilePattern)
      .filter((rule): rule is IgnoreRule => rule !== null);
  }

  static fromFileContents(contents: string): GitignoreMatcher {
    return new GitignoreMatcher(contents.split(/\r?\n/));
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  /**
   * `relativePath` is relative to the directory holding the .gitignore, in posix form.
   * The last matching rule wins, which is how a later `!pattern` re-includes a file.
   */
  ignores(relativePath: string): boolean {
    const path = toPosixPath(relativePath);
    let ignored = false;

    for (const rule of this.rules) {
      // A directory-only rule matches the directory itself and anything beneath it; the
      // compiled trailing segment already covers the "beneath it" case.
      if (!rule.regexp.test(path)) continue;
      ignored = !rule.negated;
    }

    return ignored;
  }
}

export const EMPTY_GITIGNORE = new GitignoreMatcher([]);
