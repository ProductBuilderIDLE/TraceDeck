import { describe, expect, it } from 'vitest';
import type { Finding } from '@shared/types';
import { lineMarksForFile, liveConflictMarks, withLiveConflicts } from '@shared/sourceMarkers';

function finding(overrides: Partial<Finding> & Pick<Finding, 'findingType' | 'title' | 'details'>): Finding {
  return {
    id: 1,
    projectId: 1,
    scanId: 1,
    severity: 'high',
    description: '',
    relatedNodeIds: [`file:${'filePath' in overrides.details ? overrides.details.filePath : 'src/app.ts'}`],
    fingerprint: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    dismissedAt: null,
    ...overrides,
  };
}

describe('lineMarksForFile', () => {
  it('marks a merge conflict orange across its span', () => {
    const marks = lineMarksForFile(
      [
        finding({
          findingType: 'merge-conflict',
          title: 'Unresolved merge conflict in src/app.ts',
          details: {
            kind: 'merge-conflict',
            filePath: 'src/app.ts',
            startLine: 4,
            endLine: 6,
            complete: true,
            label: 'HEAD',
          },
        }),
      ],
      'src/app.ts',
    );

    expect(marks.get(4)?.kind).toBe('conflict');
    expect(marks.get(5)?.kind).toBe('conflict');
    expect(marks.get(6)?.kind).toBe('conflict');
    expect(marks.has(3)).toBe(false);
  });

  it('marks syntax, type, and unresolved lines red', () => {
    const marks = lineMarksForFile(
      [
        finding({
          findingType: 'syntax-error',
          title: 'Invalid JSON',
          details: {
            kind: 'syntax-error',
            filePath: 'src/app.ts',
            line: 2,
            column: 1,
            code: 0,
            message: 'Unexpected token',
          },
        }),
        finding({
          findingType: 'type-error',
          title: 'TS2322',
          details: {
            kind: 'type-error',
            filePath: 'src/app.ts',
            line: 8,
            column: 3,
            code: 2322,
            category: 'error',
            message: 'Type mismatch',
          },
        }),
        finding({
          findingType: 'unresolved-import',
          title: 'Could not resolve "./missing"',
          details: {
            kind: 'unresolved-import',
            filePath: 'src/app.ts',
            specifier: './missing',
            line: 1,
            reason: 'file-not-found',
          },
        }),
      ],
      'src/app.ts',
    );

    expect(marks.get(1)?.kind).toBe('broken');
    expect(marks.get(2)?.kind).toBe('broken');
    expect(marks.get(8)?.kind).toBe('broken');
  });

  it('lets a conflict win when it overlaps a broken line', () => {
    const marks = lineMarksForFile(
      [
        finding({
          id: 1,
          findingType: 'syntax-error',
          title: 'Invalid JSON',
          details: {
            kind: 'syntax-error',
            filePath: 'src/app.ts',
            line: 4,
            column: 1,
            code: 0,
            message: 'Unexpected token',
          },
        }),
        finding({
          id: 2,
          findingType: 'merge-conflict',
          title: 'Unresolved merge conflict',
          details: {
            kind: 'merge-conflict',
            filePath: 'src/app.ts',
            startLine: 4,
            endLine: 4,
            complete: true,
            label: 'HEAD',
          },
        }),
      ],
      'src/app.ts',
    );

    expect(marks.get(4)?.kind).toBe('conflict');
    expect(marks.get(4)?.titles).toEqual(['Invalid JSON', 'Unresolved merge conflict']);
  });

  it('ignores dismissed findings and other files', () => {
    const marks = lineMarksForFile(
      [
        finding({
          dismissedAt: '2026-01-01T00:00:00.000Z',
          findingType: 'syntax-error',
          title: 'gone',
          details: {
            kind: 'syntax-error',
            filePath: 'src/app.ts',
            line: 1,
            column: 1,
            code: 0,
            message: 'x',
          },
        }),
        finding({
          findingType: 'syntax-error',
          title: 'other file',
          details: {
            kind: 'syntax-error',
            filePath: 'src/other.ts',
            line: 1,
            column: 1,
            code: 0,
            message: 'x',
          },
        }),
      ],
      'src/app.ts',
    );

    expect(marks.size).toBe(0);
  });
});

describe('liveConflictMarks', () => {
  it('marks a complete conflict span from the live buffer', () => {
    const text = ['keep', '<<<<<<< HEAD', 'left', '=======', 'right', '>>>>>>> other', 'after'].join(
      '\n',
    );
    const marks = liveConflictMarks(text);
    expect(marks.get(2)?.kind).toBe('conflict');
    expect(marks.get(6)?.kind).toBe('conflict');
    expect(marks.has(1)).toBe(false);
    expect(marks.has(7)).toBe(false);
  });

  it('marks only the start line of an unterminated group', () => {
    const marks = liveConflictMarks('<<<<<<< HEAD\nleft\n=======');
    expect([...marks.keys()]).toEqual([1]);
  });
});

describe('withLiveConflicts', () => {
  it('drops scan conflict marks that are no longer in the buffer', () => {
    const scan = lineMarksForFile(
      [
        finding({
          findingType: 'merge-conflict',
          title: 'Unresolved merge conflict in src/app.ts',
          details: {
            kind: 'merge-conflict',
            filePath: 'src/app.ts',
            startLine: 4,
            endLine: 6,
            complete: true,
            label: 'HEAD',
          },
        }),
        finding({
          findingType: 'syntax-error',
          title: 'Invalid JSON',
          details: {
            kind: 'syntax-error',
            filePath: 'src/app.ts',
            line: 2,
            column: 1,
            code: 0,
            message: 'Unexpected token',
          },
        }),
      ],
      'src/app.ts',
    );

    const merged = withLiveConflicts(scan, 'const a = 1;\nconst b = 2;\n');
    expect(merged.has(4)).toBe(false);
    expect(merged.get(2)?.kind).toBe('broken');
  });

  it('adds a conflict typed into the buffer before a scan', () => {
    const merged = withLiveConflicts(new Map(), '<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> x\n');
    expect(merged.get(1)?.kind).toBe('conflict');
    expect(merged.get(5)?.kind).toBe('conflict');
  });
});
