import { describe, expect, it } from 'vitest';
import { GraphIndex } from '@main/analysis/algorithms/graphIndex';
import {
  countAllDependents,
  reachableFrom,
  splitByDepth,
  traverse,
} from '@main/analysis/algorithms/blastRadius';
import type { AdjacencyEdge } from '@main/db/repositories/edgeRepository';
import type { EdgeType } from '@shared/types';

function edge(from: string, to: string, edgeType: EdgeType = 'import'): AdjacencyEdge {
  return { from, to, edgeType, unresolved: false, sourceLine: 1, specifier: null };
}

/**
 *   file:app  -> file:mid -> file:core
 *   file:page -> file:mid
 *   file:core -> file:util
 */
function sampleIndex(): GraphIndex {
  return new GraphIndex([
    edge('file:app.ts', 'file:mid.ts'),
    edge('file:page.ts', 'file:mid.ts'),
    edge('file:mid.ts', 'file:core.ts'),
    edge('file:core.ts', 'file:util.ts'),
  ]);
}

describe('traverse dependents', () => {
  it('finds direct dependents at depth 1', () => {
    const { entries } = traverse(sampleIndex(), 'file:mid.ts', {
      maxDepth: 5,
      direction: 'dependents',
    });

    expect(splitByDepth(entries).direct.map((e) => e.nodeId).sort()).toEqual([
      'file:app.ts',
      'file:page.ts',
    ]);
  });

  it('finds transitive dependents with increasing depth', () => {
    const { entries } = traverse(sampleIndex(), 'file:util.ts', {
      maxDepth: 5,
      direction: 'dependents',
    });

    const byId = Object.fromEntries(entries.map((e) => [e.nodeId, e.depth]));
    expect(byId).toEqual({
      'file:core.ts': 1,
      'file:mid.ts': 2,
      'file:app.ts': 3,
      'file:page.ts': 3,
    });
  });

  it('records the shortest explanation path back to the root', () => {
    const { entries } = traverse(sampleIndex(), 'file:util.ts', {
      maxDepth: 5,
      direction: 'dependents',
    });
    const app = entries.find((e) => e.nodeId === 'file:app.ts');

    expect(app?.explanationPath).toEqual(['util.ts', 'core.ts', 'mid.ts', 'app.ts']);
  });

  it('records the edge type used at each hop', () => {
    const index = new GraphIndex([
      edge('file:a.ts', 'file:b.ts', 'dynamic-import'),
      edge('file:b.ts', 'file:c.ts', 'import'),
    ]);

    const { entries } = traverse(index, 'file:c.ts', { maxDepth: 5, direction: 'dependents' });
    const a = entries.find((e) => e.nodeId === 'file:a.ts');

    expect(a?.edgeTypes).toEqual(['import', 'dynamic-import']);
  });

  it('stops at the requested depth and reports the result as truncated', () => {
    const { entries, truncated } = traverse(sampleIndex(), 'file:util.ts', {
      maxDepth: 1,
      direction: 'dependents',
    });

    expect(entries.map((e) => e.nodeId)).toEqual(['file:core.ts']);
    expect(truncated).toBe(true);
  });

  it('does not report truncation when the whole graph fits in the depth limit', () => {
    const { truncated } = traverse(sampleIndex(), 'file:util.ts', {
      maxDepth: 10,
      direction: 'dependents',
    });

    expect(truncated).toBe(false);
  });

  it('returns nothing for a node nothing depends on', () => {
    const { entries } = traverse(sampleIndex(), 'file:app.ts', {
      maxDepth: 5,
      direction: 'dependents',
    });

    expect(entries).toEqual([]);
  });

  it('terminates on a cyclic graph without revisiting nodes', () => {
    const index = new GraphIndex([edge('file:a.ts', 'file:b.ts'), edge('file:b.ts', 'file:a.ts')]);

    const { entries } = traverse(index, 'file:a.ts', { maxDepth: 10, direction: 'dependents' });

    expect(entries.map((e) => e.nodeId)).toEqual(['file:b.ts']);
  });
});

describe('traverse dependencies', () => {
  it('walks outgoing edges instead of incoming ones', () => {
    const { entries } = traverse(sampleIndex(), 'file:app.ts', {
      maxDepth: 5,
      direction: 'dependencies',
    });

    expect(entries.map((e) => e.nodeId)).toEqual(['file:mid.ts', 'file:core.ts', 'file:util.ts']);
  });

  it('splits direct from transitive dependencies', () => {
    const { entries } = traverse(sampleIndex(), 'file:app.ts', {
      maxDepth: 5,
      direction: 'dependencies',
    });
    const { direct, transitive } = splitByDepth(entries);

    expect(direct.map((e) => e.nodeId)).toEqual(['file:mid.ts']);
    expect(transitive.map((e) => e.nodeId)).toEqual(['file:core.ts', 'file:util.ts']);
  });
});

describe('symbol nodes in traversal', () => {
  it('renders a symbol node id as path#symbol', () => {
    const index = new GraphIndex([
      { ...edge('file:app.ts', 'symbol:core.ts#helper'), edgeType: 'reference' },
    ]);

    const { entries } = traverse(index, 'symbol:core.ts#helper', {
      maxDepth: 2,
      direction: 'dependents',
    });

    expect(entries[0]).toMatchObject({ nodeId: 'file:app.ts', path: 'app.ts', nodeType: 'file' });
  });
});

describe('countAllDependents', () => {
  it('counts every dependent regardless of depth', () => {
    expect(countAllDependents(sampleIndex(), 'file:util.ts')).toBe(4);
    expect(countAllDependents(sampleIndex(), 'file:mid.ts')).toBe(2);
    expect(countAllDependents(sampleIndex(), 'file:app.ts')).toBe(0);
  });

  it('does not count the node itself', () => {
    const index = new GraphIndex([edge('file:a.ts', 'file:b.ts'), edge('file:b.ts', 'file:a.ts')]);

    expect(countAllDependents(index, 'file:a.ts')).toBe(1);
  });
});

describe('reachableFrom', () => {
  it('collects everything reachable forward from the entry points', () => {
    const reachable = reachableFrom(sampleIndex(), ['file:app.ts']);

    expect([...reachable].sort()).toEqual([
      'file:app.ts',
      'file:core.ts',
      'file:mid.ts',
      'file:util.ts',
    ]);
  });

  it('excludes files no entry point reaches', () => {
    const reachable = reachableFrom(sampleIndex(), ['file:page.ts']);

    expect(reachable.has('file:app.ts')).toBe(false);
  });
});
