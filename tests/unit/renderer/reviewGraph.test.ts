import { describe, expect, it } from 'vitest';
import type {
  ReviewImpactItem,
  ReviewEdgeChange,
  ReviewCycleChange,
} from '@shared/changeReview';
import { reviewItemToGraphOverlay } from '../../../src/renderer/src/lib/reviewGraph';

function impactItem(overrides: Partial<ReviewImpactItem> = {}): ReviewImpactItem {
  return {
    itemType: 'affected-file',
    stableKey: 'impact:test',
    destinationPath: 'src/feature.ts',
    depth: 2,
    direct: true,
    originPaths: [],
    baselinePresent: true,
    targetPresent: true,
    explanations: [],
    ...overrides,
  };
}

function edgeItem(overrides: Partial<ReviewEdgeChange> = {}): ReviewEdgeChange {
  return {
    itemType: 'edge',
    stableKey: 'edge:test',
    fromPath: 'a.ts',
    toPath: 'b.ts',
    edgeType: 'import',
    typeOnly: false,
    direction: 'added',
    sourceLines: [],
    specifiers: [],
    ...overrides,
  };
}

function cycleItem(overrides: Partial<ReviewCycleChange> = {}): ReviewCycleChange {
  return {
    itemType: 'cycle',
    stableKey: 'cycle:test',
    cyclePath: ['a.ts', 'b.ts', 'c.ts', 'a.ts'],
    memberPaths: [],
    direction: 'added',
    ...overrides,
  };
}

describe('reviewItemToGraphOverlay', () => {
  it('constructs a baseline impact path overlay with stable IDs, HEAD in the title, and sorted nodes', () => {
    const item = impactItem({
      explanations: [
        {
          side: 'baseline',
          originPath: 'core.ts',
          path: ['core.ts', 'feature.ts', 'app.ts'],
          edgeTypes: ['import', 'import'],
        },
      ],
    });

    const overlay = reviewItemToGraphOverlay(item);

    expect(overlay.mode).toBe('2d');
    expect(overlay.title).toContain('HEAD');
    expect(overlay.payload.nodes.map((node) => node.path)).toEqual([
      'app.ts',
      'core.ts',
      'feature.ts',
    ]);
    expect(overlay.payload.totalNodeCount).toBe(3);
    expect(overlay.payload.edges).toHaveLength(2);

    const first = overlay.payload.edges[0];
    if (!first) throw new Error('Expected first edge');
    expect(first.source).toBe('file:core.ts');
    expect(first.target).toBe('file:feature.ts');
    expect(first.edgeType).toBe('import');

    const second = overlay.payload.edges[1];
    if (!second) throw new Error('Expected second edge');
    expect(second.source).toBe('file:feature.ts');
    expect(second.target).toBe('file:app.ts');
    expect(second.edgeType).toBe('import');

    expect(overlay.nodeMeta['file:core.ts']).toEqual({ side: 'baseline' });
    expect(overlay.nodeMeta['file:feature.ts']).toEqual({ side: 'baseline' });
    expect(overlay.nodeMeta['file:app.ts']).toEqual({ side: 'baseline' });
    expect(overlay.edgeMeta[first.id]).toEqual({ side: 'baseline' });
  });

  it('marks added and removed edges with delta metadata', () => {
    const added = reviewItemToGraphOverlay(edgeItem());
    const removed = reviewItemToGraphOverlay(edgeItem({ direction: 'removed' }));

    expect(added.nodeMeta['file:a.ts']?.delta).toBe('added');
    expect(added.nodeMeta['file:b.ts']?.delta).toBe('added');
    expect(added.edgeMeta[added.payload.edges[0]?.id ?? '']).toEqual({ delta: 'added' });

    expect(removed.nodeMeta['file:a.ts']?.delta).toBe('removed');
    expect(removed.nodeMeta['file:b.ts']?.delta).toBe('removed');
    expect(removed.edgeMeta[removed.payload.edges[0]?.id ?? '']).toEqual({ delta: 'removed' });
  });

  it('creates stable node and edge IDs for cycle path evidence', () => {
    const overlay = reviewItemToGraphOverlay(cycleItem());

    expect(overlay.payload.nodes.map((node) => node.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(overlay.payload.edges).toHaveLength(3);
    const ids = overlay.payload.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'file:a.ts|file:b.ts|import',
      'file:b.ts|file:c.ts|import',
      'file:c.ts|file:a.ts|import',
    ]);
  });

  it('sets the graph payload to non-truncated', () => {
    const overlay = reviewItemToGraphOverlay(impactItem());
    expect(overlay.payload.truncated).toBe(false);
    expect(overlay.payload.totalNodeCount).toBe(overlay.payload.nodes.length);
  });
});
