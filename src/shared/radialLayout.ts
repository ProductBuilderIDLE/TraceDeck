import type { GraphNode } from './types';

/**
 * Places every file in a project on a sphere around a single root, with folders forming the
 * branching skeleton.
 *
 * The alternative — a 3D force simulation — clusters what is connected, which sounds right
 * and reads as a hairball: at a few thousand nodes the branches overlap and the picture
 * stops answering questions. A hierarchy is what a repository actually has, so this lays the
 * folder tree out first and draws dependencies across it. Structure comes from the paths,
 * which are known and stable; only the arcs depend on the graph.
 *
 * Each node owns a rectangle of an equal-area map of the sphere, and its children divide
 * that rectangle in proportion to how many files they contain. Equal area matters: a
 * latitude/longitude split would crowd everything near the poles and leave the equator
 * empty. Splitting along the rectangle's longer side keeps regions compact rather than
 * degenerating into slivers as the tree deepens.
 *
 * The layout is deterministic. The same file list always produces the same positions, so a
 * rescan does not shuffle the space a reader has learned.
 */

export interface SpaceNode {
  /** Real graph node id for a file; a synthetic `folder:<path>` id for a folder. */
  id: string;
  label: string;
  path: string;
  kind: 'folder' | 'file';
  depth: number;
  position: readonly [number, number, number];
  parentId: string | null;
  /** Files at or below this node; drives how much of the sphere it is given. */
  leafCount: number;
}

export interface SpaceLayout {
  nodes: SpaceNode[];
  /** Skeleton connections, parent to child. Dependency edges are drawn separately. */
  trunk: Array<readonly [string, string]>;
  positionById: Map<string, readonly [number, number, number]>;
  /** Distance from the origin to the outermost node, for framing the camera. */
  extent: number;
}

/** Distance between consecutive depths. Constant, so depth reads as distance from the root. */
const RING_SPACING = 46;

export const SPACE_ROOT_ID = 'folder:';

interface TreeNode {
  id: string;
  label: string;
  path: string;
  kind: 'folder' | 'file';
  parentId: string | null;
  children: TreeNode[];
  leafCount: number;
}

/** A rectangle on the equal-area sphere map: `u` is azimuth, `v` is height. */
interface Region {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * Maps a point of the unit square to the unit sphere, preserving area.
 *
 * `v` becomes the height directly rather than an angle, which is what keeps the mapping
 * equal-area: bands of equal height on a sphere have equal surface area.
 */
function toDirection(u: number, v: number): readonly [number, number, number] {
  const theta = 2 * Math.PI * u;
  const y = 1 - 2 * v;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  return [ring * Math.cos(theta), y, ring * Math.sin(theta)];
}

function folderOf(path: string): string[] {
  const parts = path.split('/').filter((part) => part.length > 0);
  parts.pop();
  return parts;
}

function buildTree(nodes: readonly GraphNode[]): { root: TreeNode; byId: Map<string, TreeNode> } {
  const root: TreeNode = {
    id: SPACE_ROOT_ID,
    label: 'project',
    path: '',
    kind: 'folder',
    parentId: null,
    children: [],
    leafCount: 0,
  };

  const byId = new Map<string, TreeNode>([[root.id, root]]);

  const folderNode = (segments: readonly string[]): TreeNode => {
    let current = root;
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
      const id = `folder:${prefix}`;
      let next = byId.get(id);
      if (!next) {
        next = {
          id,
          label: segment,
          path: prefix,
          kind: 'folder',
          parentId: current.id,
          children: [],
          leafCount: 0,
        };
        byId.set(id, next);
        current.children.push(next);
      }
      current = next;
    }
    return current;
  };

  for (const node of nodes) {
    // A symbol lives at `path#symbol`; it is placed with the file that declares it.
    const filePath = node.path.split('#')[0] ?? node.path;
    const parent = folderNode(folderOf(filePath));
    if (byId.has(node.id)) continue;

    const leaf: TreeNode = {
      id: node.id,
      label: node.label,
      path: node.path,
      kind: 'file',
      parentId: parent.id,
      children: [],
      leafCount: 1,
    };
    byId.set(leaf.id, leaf);
    parent.children.push(leaf);
  }

  return { root, byId };
}

/** Counts leaves bottom-up. A folder holding no files still occupies a minimum of one. */
function countLeaves(node: TreeNode): number {
  if (node.children.length === 0) {
    node.leafCount = node.kind === 'file' ? 1 : 1;
    return node.leafCount;
  }
  let total = 0;
  for (const child of node.children) total += countLeaves(child);
  node.leafCount = total;
  return total;
}

/**
 * Divides a region among children in proportion to the files they hold.
 *
 * The split runs along whichever side is longer, which stops a deep tree from slicing the
 * same axis over and over and reducing every region to an unusable sliver.
 */
function splitRegion(region: Region, children: readonly TreeNode[]): Region[] {
  const total = children.reduce((sum, child) => sum + child.leafCount, 0);
  if (total === 0) return children.map(() => region);

  const width = region.u1 - region.u0;
  const height = region.v1 - region.v0;
  const alongU = width >= height;

  const regions: Region[] = [];
  let offset = 0;
  for (const child of children) {
    const share = child.leafCount / total;
    const start = offset;
    const end = offset + share;
    offset = end;

    regions.push(
      alongU
        ? {
            u0: region.u0 + width * start,
            u1: region.u0 + width * end,
            v0: region.v0,
            v1: region.v1,
          }
        : {
            u0: region.u0,
            u1: region.u1,
            v0: region.v0 + height * start,
            v1: region.v0 + height * end,
          },
    );
  }

  return regions;
}

/**
 * Builds the spatial layout for a set of graph nodes.
 *
 * Children are visited in a stable order so that two runs over the same files agree, and a
 * file added to one folder does not move every other branch.
 */
export function buildRadialLayout(nodes: readonly GraphNode[]): SpaceLayout {
  const placed: SpaceNode[] = [];
  const trunk: Array<readonly [string, string]> = [];
  const positionById = new Map<string, readonly [number, number, number]>();

  if (nodes.length === 0) {
    return { nodes: placed, trunk, positionById, extent: RING_SPACING };
  }

  const { root } = buildTree(nodes);
  countLeaves(root);

  let extent = 0;

  const place = (node: TreeNode, region: Region, depth: number): void => {
    const centre = toDirection((region.u0 + region.u1) / 2, (region.v0 + region.v1) / 2);
    const radius = depth * RING_SPACING;
    // Adding zero collapses -0 to 0. The two are the same point, but they are not the same
    // value, and positions are compared to check that a rescan did not move anything.
    const position: readonly [number, number, number] = [
      centre[0] * radius + 0,
      centre[1] * radius + 0,
      centre[2] * radius + 0,
    ];

    placed.push({
      id: node.id,
      label: node.label,
      path: node.path,
      kind: node.kind,
      depth,
      position,
      parentId: node.parentId,
      leafCount: node.leafCount,
    });
    positionById.set(node.id, position);
    if (radius > extent) extent = radius;
    if (node.parentId !== null) trunk.push([node.parentId, node.id] as const);

    if (node.children.length === 0) return;

    // Folders before files, then by name: directories read as the structure, and a file
    // keeps its place when a sibling folder gains contents.
    const ordered = [...node.children].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      return left.label.localeCompare(right.label);
    });

    const regions = splitRegion(region, ordered);
    ordered.forEach((child, index) => {
      place(child, regions[index] ?? region, depth + 1);
    });
  };

  place(root, { u0: 0, u1: 1, v0: 0, v1: 1 }, 0);

  return { nodes: placed, trunk, positionById, extent: Math.max(extent, RING_SPACING) };
}

/**
 * Builds a curved path between two placed nodes.
 *
 * Dependency arcs bow toward the centre rather than running straight. A straight chord
 * between two outer branches passes through the middle of the tree and visually attaches
 * itself to whatever it crosses; pulling the curve inward keeps the line readable as one
 * connection with two ends.
 */
export function arcPoints(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  segments = 12,
): number[] {
  const midpoint: [number, number, number] = [
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2,
    (from[2] + to[2]) / 2,
  ];
  const control: [number, number, number] = [
    midpoint[0] * 0.55,
    midpoint[1] * 0.55,
    midpoint[2] * 0.55,
  ];

  const points: number[] = [];
  for (let step = 0; step <= segments; step += 1) {
    const t = step / segments;
    const inverse = 1 - t;
    const a = inverse * inverse;
    const b = 2 * inverse * t;
    const c = t * t;
    points.push(
      a * from[0] + b * control[0] + c * to[0],
      a * from[1] + b * control[1] + c * to[1],
      a * from[2] + b * control[2] + c * to[2],
    );
  }
  return points;
}
