import { describe, expect, it } from 'vitest';
import { diagnoseJson, findMergeConflicts, isJsonPath } from '@main/analysis/textDiagnostics';

describe('findMergeConflicts', () => {
  it('reports a complete three-way conflict group with both boundaries', () => {
    const text = [
      'const a = 1;',
      '<<<<<<< HEAD',
      'const b = 2;',
      '=======',
      'const b = 3;',
      '>>>>>>> feature/branch',
      'const c = 4;',
    ].join('\n');

    expect(findMergeConflicts(text)).toEqual([
      { startLine: 2, endLine: 6, complete: true, label: 'HEAD' },
    ]);
  });

  it('reports an unterminated group, which is the case most worth surfacing', () => {
    const text = ['<<<<<<< HEAD', 'const b = 2;', '=======', 'const b = 3;'].join('\n');

    expect(findMergeConflicts(text)).toEqual([
      { startLine: 1, endLine: null, complete: false, label: 'HEAD' },
    ]);
  });

  it('finds every group in a file with more than one conflict', () => {
    const text = [
      '<<<<<<< HEAD',
      'a',
      '=======',
      'b',
      '>>>>>>> other',
      'middle',
      '<<<<<<< HEAD',
      'c',
      '=======',
      'd',
      '>>>>>>> other',
    ].join('\n');

    expect(findMergeConflicts(text).map((c) => c.startLine)).toEqual([1, 7]);
  });

  it('does not report prose that merely talks about conflict markers', () => {
    const text = [
      'When git cannot merge it writes <<<<<<< into the file.',
      'The ======= line separates the two sides.',
      'Then >>>>>>> closes it.',
    ].join('\n');

    expect(findMergeConflicts(text)).toEqual([]);
  });

  it('does not treat a Markdown heading underline as a conflict separator', () => {
    const text = ['Title', '=======', '', 'Body text.'].join('\n');

    expect(findMergeConflicts(text)).toEqual([]);
  });

  it('requires exactly seven marker characters', () => {
    const text = ['<<<<<< HEAD', 'a', '=======', 'b', '>>>>>> other'].join('\n');

    expect(findMergeConflicts(text)).toEqual([]);
  });

  it('handles CRLF line endings without shifting line numbers', () => {
    const text = ['x', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> other'].join('\r\n');

    expect(findMergeConflicts(text)[0]).toMatchObject({ startLine: 2, endLine: 6 });
  });

  it('reports a marker pair with no separator as incomplete', () => {
    const text = ['<<<<<<< HEAD', 'a', '>>>>>>> other'].join('\n');

    expect(findMergeConflicts(text)).toEqual([
      { startLine: 1, endLine: 3, complete: false, label: 'HEAD' },
    ]);
  });

  it('finds nothing in an ordinary file', () => {
    expect(findMergeConflicts('const a = 1;\nconst b = 2;\n')).toEqual([]);
  });
});

describe('diagnoseJson', () => {
  it('accepts valid JSON', () => {
    expect(diagnoseJson('a.json', '{ "a": 1 }')).toEqual([]);
  });

  it('locates a trailing comma', () => {
    const found = diagnoseJson('a.json', '{\n  "a": 1,\n}');

    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.line).toBeGreaterThan(0);
    expect(found[0]?.column).toBeGreaterThan(0);
  });

  it('locates a missing closing brace', () => {
    expect(diagnoseJson('a.json', '{ "a": 1 ').length).toBeGreaterThan(0);
  });

  it('reports a stable result across runs', () => {
    const text = '{ "a": [1, 2,, 3] }';
    expect(diagnoseJson('a.json', text)).toEqual(diagnoseJson('a.json', text));
  });
});

describe('isJsonPath', () => {
  it('recognises JSON extensions and nothing else', () => {
    expect(isJsonPath('a.json')).toBe(true);
    expect(isJsonPath('tsconfig.jsonc')).toBe(true);
    expect(isJsonPath('a.ts')).toBe(false);
    expect(isJsonPath('a.jsonx')).toBe(false);
  });
});
