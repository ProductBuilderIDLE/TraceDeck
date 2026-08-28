import { describe, expect, it } from 'vitest';
import { GitignoreMatcher } from '@main/utils/gitignore';

function matcher(...lines: string[]): GitignoreMatcher {
  return GitignoreMatcher.fromFileContents(lines.join('\n'));
}

describe('GitignoreMatcher', () => {
  it('ignores a plain file name anywhere in the tree', () => {
    const rules = matcher('secrets.ts');

    expect(rules.ignores('secrets.ts')).toBe(true);
    expect(rules.ignores('src/deep/secrets.ts')).toBe(true);
    expect(rules.ignores('src/other.ts')).toBe(false);
  });

  it('anchors a pattern that starts with a slash', () => {
    const rules = matcher('/build');

    expect(rules.ignores('build')).toBe(true);
    expect(rules.ignores('build/output.js')).toBe(true);
    expect(rules.ignores('src/build/output.js')).toBe(false);
  });

  it('ignores a directory and everything inside it', () => {
    const rules = matcher('coverage/');

    expect(rules.ignores('coverage')).toBe(true);
    expect(rules.ignores('coverage/lcov.info')).toBe(true);
    expect(rules.ignores('coverage/deep/nested/file.ts')).toBe(true);
  });

  it('supports wildcards within a segment', () => {
    const rules = matcher('*.generated.ts');

    expect(rules.ignores('schema.generated.ts')).toBe(true);
    expect(rules.ignores('src/api/schema.generated.ts')).toBe(true);
    expect(rules.ignores('schema.ts')).toBe(false);
  });

  it('lets a later negation re-include a file', () => {
    const rules = matcher('dist/', '!dist/keep.ts');

    expect(rules.ignores('dist/other.ts')).toBe(true);
    expect(rules.ignores('dist/keep.ts')).toBe(false);
  });

  it('applies rules in order so an earlier negation can be overridden', () => {
    const rules = matcher('!keep.ts', 'keep.ts');

    expect(rules.ignores('keep.ts')).toBe(true);
  });

  it('skips comments and blank lines', () => {
    const rules = matcher('# a comment', '', '   ', 'real.ts');

    expect(rules.ruleCount).toBe(1);
    expect(rules.ignores('real.ts')).toBe(true);
  });

  it('matches across segments with **', () => {
    const rules = matcher('src/**/temp');

    expect(rules.ignores('src/temp')).toBe(true);
    expect(rules.ignores('src/a/b/temp')).toBe(true);
    expect(rules.ignores('other/temp')).toBe(false);
  });

  it('ignores nothing when it has no rules', () => {
    expect(new GitignoreMatcher([]).ignores('anything.ts')).toBe(false);
  });

  it('reports whether a negation matched instead of looking like no matching rule', () => {
    const rules = matcher('*.ts', '!keep.ts');

    if (!('decision' in rules)) {
      expect('decision' in rules).toBe(true);
      return;
    }

    const decision = (
      rules as GitignoreMatcher & {
        decision(relativePath: string): {
          matched: boolean;
          ignored: boolean;
          pattern: string | null;
        };
      }
    ).decision('src/keep.ts');

    expect(decision).toEqual({ matched: true, ignored: false, pattern: '!keep.ts' });
  });
});
