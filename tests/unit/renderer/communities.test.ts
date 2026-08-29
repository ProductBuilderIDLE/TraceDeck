import { describe, expect, it } from 'vitest';
import { detectCommunities, type CommunityEdge } from '@shared/communities';

function edge(source: string, target: string): CommunityEdge {
  return { source, target };
}

/** Two tightly connected groups joined by a single bridge — the textbook case. */
function twoClusters(): { nodes: string[]; edges: CommunityEdge[] } {
  const nodes = ['file:a1', 'file:a2', 'file:a3', 'file:b1', 'file:b2', 'file:b3'];
  const edges = [
    edge('file:a1', 'file:a2'),
    edge('file:a2', 'file:a3'),
    edge('file:a3', 'file:a1'),
    edge('file:b1', 'file:b2'),
    edge('file:b2', 'file:b3'),
    edge('file:b3', 'file:b1'),
    edge('file:a1', 'file:b1'),
  ];
  return { nodes, edges };
}

describe('detectCommunities', () => {
  it('separates two clusters joined by a single edge', () => {
    const { nodes, edges } = twoClusters();
    const result = detectCommunities(nodes, edges);

    const a = result.communityById.get('file:a1');
    expect(result.communityById.get('file:a2')).toBe(a);
    expect(result.communityById.get('file:a3')).toBe(a);

    const b = result.communityById.get('file:b1');
    expect(result.communityById.get('file:b2')).toBe(b);
    expect(result.communityById.get('file:b3')).toBe(b);

    expect(a).not.toBe(b);
  });

  it('scores a clearly separated graph above zero modularity', () => {
    const { nodes, edges } = twoClusters();

    expect(detectCommunities(nodes, edges).modularity).toBeGreaterThan(0.2);
  });

  it('puts every node in exactly one community', () => {
    const { nodes, edges } = twoClusters();
    const result = detectCommunities(nodes, edges);
    const assigned = result.communities.flatMap((community) => community.nodes);

    expect(assigned).toHaveLength(nodes.length);
    expect(new Set(assigned).size).toBe(nodes.length);
  });

  it('leaves an unconnected file in its own community rather than guessing', () => {
    const { nodes, edges } = twoClusters();
    const result = detectCommunities([...nodes, 'file:lonely'], edges);
    const lonely = result.communities.find((community) =>
      community.nodes.includes('file:lonely'),
    );

    expect(lonely?.nodes).toEqual(['file:lonely']);
  });

  it('treats an edge as undirected, so direction does not change grouping', () => {
    const { nodes, edges } = twoClusters();
    const flipped = edges.map((item) => edge(item.target, item.source));

    expect(detectCommunities(nodes, flipped).communityById).toEqual(
      detectCommunities(nodes, edges).communityById,
    );
  });

  it('produces the same result regardless of input order', () => {
    const { nodes, edges } = twoClusters();
    const forward = detectCommunities(nodes, edges);
    const reversed = detectCommunities([...nodes].reverse(), [...edges].reverse());

    expect(reversed.communityById).toEqual(forward.communityById);
  });

  it('is stable across repeated runs', () => {
    const { nodes, edges } = twoClusters();

    expect(detectCommunities(nodes, edges)).toEqual(detectCommunities(nodes, edges));
  });

  it('numbers the largest community zero so colours stay put', () => {
    const nodes = ['file:a1', 'file:a2', 'file:a3', 'file:a4', 'file:b1', 'file:b2'];
    const result = detectCommunities(nodes, [
      edge('file:a1', 'file:a2'),
      edge('file:a2', 'file:a3'),
      edge('file:a3', 'file:a4'),
      edge('file:a4', 'file:a1'),
      edge('file:b1', 'file:b2'),
    ]);

    expect(result.communities[0]!.nodes.length).toBeGreaterThanOrEqual(
      result.communities[1]!.nodes.length,
    );
  });

  it('names a community after the directory its files share', () => {
    const result = detectCommunities(
      ['file:src/auth/login.ts', 'file:src/auth/token.ts', 'file:src/auth/session.ts'],
      [
        edge('file:src/auth/login.ts', 'file:src/auth/token.ts'),
        edge('file:src/auth/token.ts', 'file:src/auth/session.ts'),
      ],
    );

    expect(result.communities[0]!.label).toBe('src/auth');
  });

  it('names a mixed community after the parent the members share', () => {
    const result = detectCommunities(
      ['file:src/api/client.ts', 'file:src/db/store.ts'],
      [edge('file:src/api/client.ts', 'file:src/db/store.ts')],
    );

    expect(result.communities[0]!.label).toBe('src');
  });

  it('handles a graph with no edges at all', () => {
    const result = detectCommunities(['file:a', 'file:b'], []);

    expect(result.communities).toHaveLength(2);
    expect(result.modularity).toBe(0);
  });

  it('handles an empty graph', () => {
    const result = detectCommunities([], []);

    expect(result.communities).toEqual([]);
    expect(result.communityById.size).toBe(0);
  });

  it('ignores an edge pointing at a node that is not present', () => {
    const result = detectCommunities(['file:a'], [edge('file:a', 'file:missing')]);

    expect(result.communities).toHaveLength(1);
    expect(result.communityById.get('file:a')).toBe(0);
  });

  it('groups a realistic layered graph into fewer communities than files', () => {
    const nodes: string[] = [];
    const edges: CommunityEdge[] = [];
    for (const area of ['auth', 'billing', 'search']) {
      for (let index = 0; index < 8; index += 1) nodes.push(`file:src/${area}/m${index}.ts`);
      for (let index = 0; index < 7; index += 1) {
        edges.push(edge(`file:src/${area}/m${index}.ts`, `file:src/${area}/m${index + 1}.ts`));
      }
      edges.push(edge(`file:src/${area}/m7.ts`, `file:src/${area}/m0.ts`));
    }
    edges.push(edge('file:src/auth/m0.ts', 'file:src/billing/m0.ts'));
    edges.push(edge('file:src/billing/m0.ts', 'file:src/search/m0.ts'));

    const result = detectCommunities(nodes, edges);

    expect(result.communities.length).toBeGreaterThan(1);
    expect(result.communities.length).toBeLessThan(nodes.length);
    expect(result.modularity).toBeGreaterThan(0.3);
  });
});
