import { describe, expect, it } from 'vitest';
import { lineCompletion } from '@shared/bufferCompletion';
import { liveJsonSyntaxIssue } from '@shared/jsonSyntax';

describe('lineCompletion', () => {
  it('suggests the remainder of a matching line elsewhere in the file', () => {
    const lines = ['const name = "trace";', 'const n'];
    expect(lineCompletion(lines, 1, 'const n'.length)).toBe('ame = "trace";');
  });

  it('ignores short prefixes and the current line', () => {
    expect(lineCompletion(['ab', 'ab'], 1, 1)).toBeNull();
    expect(lineCompletion(['xyzzy unique prefix', 'completely different'], 0, 8)).toBeNull();
  });
});

describe('liveJsonSyntaxIssue', () => {
  it('reports a parse failure on a .json file', () => {
    const issue = liveJsonSyntaxIssue('package.json', '{ "a": 1, }');
    expect(issue).not.toBeNull();
    expect(issue?.line).toBeGreaterThan(0);
  });

  it('ignores jsonc and valid json', () => {
    expect(liveJsonSyntaxIssue('tsconfig.jsonc', '{ "a": 1, }')).toBeNull();
    expect(liveJsonSyntaxIssue('a.json', '{ "a": 1 }')).toBeNull();
  });
});
