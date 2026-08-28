import { describe, expect, it } from 'vitest';
import { diffHunks, hunkSummary, splitLines } from '@shared/lineDiff';

describe('splitLines', () => {
  it('treats an empty document as no lines', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('drops a trailing carriage return from CRLF files', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b', '']);
  });
});

describe('diffHunks', () => {
  it('returns nothing when the texts are identical', () => {
    expect(diffHunks('const a = 1;\n', 'const a = 1;\n')).toEqual([]);
  });

  it('records an inserted line', () => {
    const hunks = diffHunks('a\nc\n', 'a\nb\nc\n');

    expect(hunks).toEqual([{ oldStart: 2, newStart: 2, oldLines: [], newLines: ['b'] }]);
    expect(hunkSummary(hunks[0]!)).toBe('Line 2: +1');
  });

  it('records a deleted line', () => {
    const hunks = diffHunks('a\nb\nc\n', 'a\nc\n');

    expect(hunks).toEqual([{ oldStart: 2, newStart: 2, oldLines: ['b'], newLines: [] }]);
    expect(hunkSummary(hunks[0]!)).toBe('Line 2: −1');
  });

  it('records a replaced line as old then new', () => {
    const hunks = diffHunks('keep\nold\nkeep\n', 'keep\nnew\nkeep\n');

    expect(hunks).toEqual([{ oldStart: 2, newStart: 2, oldLines: ['old'], newLines: ['new'] }]);
    expect(hunkSummary(hunks[0]!)).toBe('Line 2: −1 / +1');
  });

  it('keeps two separate edits as two hunks', () => {
    const hunks = diffHunks('a\nb\nc\nd\n', 'a\nB\nc\nD\n');

    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({ oldStart: 2, newStart: 2, oldLines: ['b'], newLines: ['B'] });
    expect(hunks[1]).toEqual({ oldStart: 4, newStart: 4, oldLines: ['d'], newLines: ['D'] });
  });

  it('diffs an empty file into content', () => {
    expect(diffHunks('', 'hello\n')).toEqual([
      { oldStart: 1, newStart: 1, oldLines: [], newLines: ['hello', ''] },
    ]);
  });
});
