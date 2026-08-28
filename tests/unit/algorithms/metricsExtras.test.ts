import { describe, expect, it } from 'vitest';
import { cyclomaticFromDecisions, COMPLEXITY_HOTSPOT_THRESHOLD } from '@main/analysis/algorithms/complexity';
import { findTodoComments } from '@main/analysis/algorithms/todos';
import { findDuplicateBlocks } from '@main/analysis/algorithms/clones';
import { computeMartinMetrics } from '@main/analysis/algorithms/martin';
import { compareFingerprints } from '@main/analysis/algorithms/scanCompare';
import { computeDiffImpact } from '@main/analysis/algorithms/diffImpact';
import { GraphIndex } from '@main/analysis/algorithms/graphIndex';
import type { AdjacencyEdge } from '@main/db/repositories/edgeRepository';
import { parseSourceFile } from '@main/analysis/parser';

function edge(from: string, to: string): AdjacencyEdge {
  return { from, to, edgeType: 'import', unresolved: false, sourceLine: 1, specifier: null };
}

describe('complexity and todos', () => {
  it('counts decision points plus one', () => {
    expect(cyclomaticFromDecisions(3)).toBe(4);
    expect(COMPLEXITY_HOTSPOT_THRESHOLD).toBe(10);
  });

  it('finds TODO FIXME and HACK comments', () => {
    const hits = findTodoComments('const x = 1;\n// TODO: wire this\n# FIXME later\n/* HACK temp */');
    expect(hits.map((hit) => hit.tag)).toEqual(['TODO', 'FIXME', 'HACK']);
  });

  it('records cyclomatic complexity on parsed functions', () => {
    const parsed = parseSourceFile(
      'a.ts',
      'export function run(x: number) { if (x) { while (x) { x -= 1; } } return x; }',
    );
    expect(parsed.calls).toEqual([]);
    expect(parsed.symbols[0]?.metadata.complexity).toBeGreaterThan(1);
  });

  it('records conservative calls', () => {
    const parsed = parseSourceFile('a.ts', `import { add } from './math';\nadd(1);\n`);
    expect(parsed.calls.some((call) => call.callee === 'add')).toBe(true);
  });
});

describe('duplicates and martin', () => {
  it('groups duplicated six-line blocks', () => {
    const block = ['a();', 'b();', 'c();', 'd();', 'e();', 'f();'].join('\n');
    const groups = findDuplicateBlocks([
      { relativePath: 'one.ts', text: `${block}\n` },
      { relativePath: 'two.ts', text: `ignore()\n${block}\n` },
    ]);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]?.filePaths).toEqual(['one.ts', 'two.ts']);
  });

  it('computes instability from cross-folder edges', () => {
    const metrics = computeMartinMetrics(
      [{ fromPath: 'src/ui/a.ts', toPath: 'src/db/b.ts' }],
      [
        { folder: 'src/ui', fileCount: 2, abstractFileCount: 0 },
        { folder: 'src/db', fileCount: 2, abstractFileCount: 1 },
      ],
    );
    const ui = metrics.find((entry) => entry.folder === 'src/ui');
    expect(ui?.efferent).toBe(1);
    expect(ui?.instability).toBe(1);
  });
});

describe('scan compare and diff impact', () => {
  it('diffs fingerprints', () => {
    const result = compareFingerprints(
      [{ fingerprint: 'a', title: 'old' }, { fingerprint: 'b', title: 'keep' }],
      [{ fingerprint: 'b', title: 'keep' }, { fingerprint: 'c', title: 'new' }],
    );
    expect(result.added.map((entry) => entry.fingerprint)).toEqual(['c']);
    expect(result.removed.map((entry) => entry.fingerprint)).toEqual(['a']);
    expect(result.persisted).toBe(1);
  });

  it('unions blast radii of changed files', () => {
    const index = new GraphIndex([
      edge('file:src/app.ts', 'file:src/core.ts'),
      edge('file:src/core.test.ts', 'file:src/core.ts'),
    ]);
    const impact = computeDiffImpact({
      changedPaths: ['src/core.ts'],
      index,
      entryPoints: ['src/app.ts'],
    });
    expect(impact.affectedPaths).toContain('src/app.ts');
    expect(impact.testPaths).toContain('src/core.test.ts');
  });
});
