import { describe, expect, it } from 'vitest';
import { GraphIndex } from '@main/analysis/algorithms/graphIndex';
import {
  detectCycles,
  findStronglyConnectedComponents,
  nodesInCycles,
} from '@main/analysis/algorithms/cycles';
import type { AdjacencyEdge } from '@main/db/repositories/edgeRepository';

function edge(from: string, to: string, line = 1): AdjacencyEdge {
  return { from, to, edgeType: 'import', unresolved: false, sourceLine: line, specifier: null };
}

function indexOf(...edges: AdjacencyEdge[]): GraphIndex {
  return new GraphIndex(edges);
}

describe('findStronglyConnectedComponents', () => {
  it('finds nothing in an acyclic graph', () => {
    const index = indexOf(edge('a', 'b'), edge('b', 'c'), edge('a', 'c'));

    expect(findStronglyConnectedComponents(index)).toEqual([]);
  });

  it('finds a two-node cycle', () => {
    const index = indexOf(edge('a', 'b'), edge('b', 'a'));

    expect(findStronglyConnectedComponents(index)).toEqual([['a', 'b']]);
  });

  it('finds a three-node cycle', () => {
    const index = indexOf(edge('a', 'b'), edge('b', 'c'), edge('c', 'a'));

    expect(findStronglyConnectedComponents(index)).toEqual([['a', 'b', 'c']]);
  });

  it('does not report a self-loop as a cycle', () => {
    const index = indexOf(edge('a', 'a'), edge('a', 'b'));

    expect(findStronglyConnectedComponents(index)).toEqual([]);
  });

  it('reports a self-looping node only when it joins a larger component', () => {
    const index = indexOf(edge('a', 'a'), edge('a', 'b'), edge('b', 'a'));

    expect(findStronglyConnectedComponents(index)).toEqual([['a', 'b']]);
  });

  it('finds several independent cycles', () => {
    const index = indexOf(
      edge('a', 'b'),
      edge('b', 'a'),
      edge('x', 'y'),
      edge('y', 'z'),
      edge('z', 'x'),
      edge('standalone', 'a'),
    );

    expect(findStronglyConnectedComponents(index)).toEqual([
      ['a', 'b'],
      ['x', 'y', 'z'],
    ]);
  });

  it('separates two cycles joined by a one-way edge', () => {
    const index = indexOf(
      edge('a', 'b'),
      edge('b', 'a'),
      edge('b', 'c'),
      edge('c', 'd'),
      edge('d', 'c'),
    );

    expect(findStronglyConnectedComponents(index)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles a long chain without overflowing the stack', () => {
    const edges: AdjacencyEdge[] = [];
    const length = 20000;
    for (let i = 0; i < length; i += 1) {
      edges.push(edge(`n${i}`, `n${i + 1}`));
    }
    // Close the chain so the whole thing is one component.
    edges.push(edge(`n${length}`, 'n0'));

    const components = findStronglyConnectedComponents(new GraphIndex(edges));

    expect(components).toHaveLength(1);
    expect(components[0]).toHaveLength(length + 1);
  });

  it('is deterministic regardless of edge insertion order', () => {
    const forward = indexOf(edge('a', 'b'), edge('b', 'c'), edge('c', 'a'));
    const reversed = indexOf(edge('c', 'a'), edge('b', 'c'), edge('a', 'b'));

    expect(findStronglyConnectedComponents(forward)).toEqual(
      findStronglyConnectedComponents(reversed),
    );
  });

  it('ignores unresolved edges by default', () => {
    const unresolvedEdge: AdjacencyEdge = {
      from: 'b',
      to: 'a',
      edgeType: 'import',
      unresolved: true,
      sourceLine: 1,
      specifier: 'a',
    };

    expect(findStronglyConnectedComponents(new GraphIndex([edge('a', 'b'), unresolvedEdge]))).toEqual(
      [],
    );
  });
});

describe('detectCycles', () => {
  it('produces a readable path that returns to its start', () => {
    const index = indexOf(edge('a', 'b'), edge('b', 'c'), edge('c', 'a'));
    const [cycle] = detectCycles(index);

    expect(cycle?.path[0]).toBe('a');
    expect(cycle?.path[cycle.path.length - 1]).toBe('a');
    expect(cycle?.path).toEqual(['a', 'b', 'c', 'a']);
  });

  it('attaches the import line to each edge in the path', () => {
    const index = indexOf(edge('a', 'b', 7), edge('b', 'a', 12));
    const [cycle] = detectCycles(index);

    expect(cycle?.edges).toEqual([
      { from: 'a', to: 'b', line: 7, specifier: null },
      { from: 'b', to: 'a', line: 12, specifier: null },
    ]);
  });

  it('lists every file in the component even when the path is shorter', () => {
    // a <-> b, and b <-> c, so all three are one component but the shortest cycle is a-b-a.
    const index = indexOf(edge('a', 'b'), edge('b', 'a'), edge('b', 'c'), edge('c', 'b'));
    const [cycle] = detectCycles(index);

    expect(cycle?.nodes).toEqual(['a', 'b', 'c']);
  });
});

describe('nodesInCycles', () => {
  it('collects every node across all cycles', () => {
    const index = indexOf(edge('a', 'b'), edge('b', 'a'), edge('x', 'y'), edge('y', 'x'));

    expect([...nodesInCycles(detectCycles(index))].sort()).toEqual(['a', 'b', 'x', 'y']);
  });

  it('is empty for an acyclic graph', () => {
    expect(nodesInCycles(detectCycles(indexOf(edge('a', 'b'))))).toEqual(new Set());
  });
});
