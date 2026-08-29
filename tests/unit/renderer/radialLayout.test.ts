import { describe, expect, it } from 'vitest';
import { arcPoints, buildRadialLayout, SPACE_ROOT_ID } from '@shared/radialLayout';
import type { GraphNode } from '@shared/types';

function file(path: string): GraphNode {
  return {
    id: `file:${path}`,
    type: 'file',
    label: path.split('/').pop() ?? path,
    path,
  };
}

function magnitude(position: readonly [number, number, number]): number {
  return Math.hypot(position[0], position[1], position[2]);
}

describe('buildRadialLayout', () => {
  it('places every file it is given', () => {
    const layout = buildRadialLayout([file('src/a.ts'), file('src/b.ts'), file('docs/c.md')]);

    for (const node of ['file:src/a.ts', 'file:src/b.ts', 'file:docs/c.md']) {
      expect(layout.positionById.has(node)).toBe(true);
    }
  });

  it('creates a folder for each directory in the paths', () => {
    const layout = buildRadialLayout([file('src/main/analysis/parser.ts')]);
    const folders = layout.nodes.filter((node) => node.kind === 'folder').map((node) => node.path);

    expect(folders).toContain('src');
    expect(folders).toContain('src/main');
    expect(folders).toContain('src/main/analysis');
  });

  it('puts the root at the origin', () => {
    const layout = buildRadialLayout([file('src/a.ts')]);
    const root = layout.nodes.find((node) => node.id === SPACE_ROOT_ID);

    expect(root?.position).toEqual([0, 0, 0]);
  });

  it('pushes each level further from the centre than its parent', () => {
    const layout = buildRadialLayout([file('src/main/deep/file.ts')]);
    const byPath = new Map(layout.nodes.map((node) => [node.path, node]));

    const src = magnitude(byPath.get('src')!.position);
    const main = magnitude(byPath.get('src/main')!.position);
    const deep = magnitude(byPath.get('src/main/deep')!.position);

    expect(main).toBeGreaterThan(src);
    expect(deep).toBeGreaterThan(main);
  });

  it('connects every placed node to its parent exactly once', () => {
    const layout = buildRadialLayout([file('src/a.ts'), file('src/b.ts'), file('lib/c.ts')]);
    const children = layout.trunk.map(([, child]) => child);

    // Everything except the root is someone's child, and nothing is a child twice.
    expect(children).toHaveLength(layout.nodes.length - 1);
    expect(new Set(children).size).toBe(children.length);
  });

  it('gives a folder holding more files more of the sphere', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name) => file(`big/${name}.ts`));
    const layout = buildRadialLayout([...many, file('small/only.ts')]);
    const byPath = new Map(layout.nodes.map((node) => [node.path, node]));

    expect(byPath.get('big')!.leafCount).toBe(8);
    expect(byPath.get('small')!.leafCount).toBe(1);
  });

  it('separates sibling files rather than stacking them at one point', () => {
    const layout = buildRadialLayout(
      Array.from({ length: 12 }, (_, index) => file(`src/file${index}.ts`)),
    );
    const positions = layout.nodes
      .filter((node) => node.kind === 'file')
      .map((node) => node.position.map((value) => value.toFixed(3)).join(','));

    expect(new Set(positions).size).toBe(12);
  });

  it('is deterministic across runs and independent of input order', () => {
    const nodes = [file('src/b.ts'), file('src/a.ts'), file('lib/c.ts')];
    const forward = buildRadialLayout(nodes);
    const reversed = buildRadialLayout([...nodes].reverse());

    expect(forward.positionById.get('file:src/a.ts')).toEqual(
      reversed.positionById.get('file:src/a.ts'),
    );
    expect(forward.positionById.get('file:lib/c.ts')).toEqual(
      reversed.positionById.get('file:lib/c.ts'),
    );
  });

  it('places a symbol with the file that declares it', () => {
    const layout = buildRadialLayout([
      { id: 'symbol:src/a.ts#helper', type: 'symbol', label: 'helper', path: 'src/a.ts#helper' },
    ]);
    const symbol = layout.nodes.find((node) => node.id === 'symbol:src/a.ts#helper');

    expect(symbol?.parentId).toBe('folder:src');
  });

  it('handles a file at the project root', () => {
    const layout = buildRadialLayout([file('README.md')]);

    expect(layout.nodes.find((node) => node.id === 'file:README.md')?.parentId).toBe(SPACE_ROOT_ID);
  });

  it('returns a usable extent for an empty project', () => {
    const layout = buildRadialLayout([]);

    expect(layout.nodes).toHaveLength(0);
    expect(layout.extent).toBeGreaterThan(0);
  });

  it('reports an extent that reaches the outermost node', () => {
    const layout = buildRadialLayout([file('a/b/c/d/deep.ts'), file('shallow.ts')]);
    const furthest = Math.max(...layout.nodes.map((node) => magnitude(node.position)));

    expect(layout.extent).toBeCloseTo(furthest, 5);
  });

  it('scales to a few thousand files without collapsing positions', () => {
    const nodes = Array.from({ length: 3000 }, (_, index) =>
      file(`src/area${index % 40}/module${index}.ts`),
    );
    const layout = buildRadialLayout(nodes);
    const unique = new Set(
      layout.nodes
        .filter((node) => node.kind === 'file')
        .map((node) => node.position.map((value) => value.toFixed(4)).join(',')),
    );

    expect(unique.size).toBe(3000);
  });
});

describe('arcPoints', () => {
  it('starts and ends at the nodes it connects', () => {
    const points = arcPoints([10, 0, 0], [0, 10, 0], 8);
    const last = points.length - 3;

    expect(points.slice(0, 3)).toEqual([10, 0, 0]);
    expect(points.slice(last)).toEqual([0, 10, 0]);
  });

  it('bows toward the centre instead of cutting straight across', () => {
    const from: [number, number, number] = [10, 0, 0];
    const to: [number, number, number] = [-10, 0, 0];
    const segments = 8;
    const points = arcPoints(from, to, segments);
    const middle = (segments / 2) * 3;
    const midpoint = Math.hypot(points[middle]!, points[middle + 1]!, points[middle + 2]!);

    // A straight chord between these two would pass exactly through the origin region;
    // the curve is what keeps a long dependency legible as one line with two ends.
    expect(midpoint).toBeLessThan(10);
  });

  it('emits one point per segment boundary', () => {
    expect(arcPoints([1, 1, 1], [2, 2, 2], 6)).toHaveLength(7 * 3);
  });
});
