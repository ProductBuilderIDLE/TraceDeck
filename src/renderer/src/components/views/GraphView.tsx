import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import dagre from 'cytoscape-dagre';
import clsx from 'clsx';
import {
  Code2,
  Crosshair,
  Loader2,
  Maximize2,
  RefreshCcw,
  Download,
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { EdgeType, NodeType, GraphPayload } from '@shared/types';
import { detectCommunities, type Community } from '@shared/communities';
import { folderNodeId } from '@shared/nodeIds';
import { GRAPH_NODE_SOFT_LIMIT } from '@shared/constants';
import { parseNodeId } from '@shared/nodeIds';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { invoke } from '../../lib/ipc';
import { tokenColor } from '../../lib/theme';
import { Button, EmptyState, Warning } from '../common/ui';

cytoscape.use(fcose);
cytoscape.use(dagre);

type LayoutName = 'fcose' | 'dagre' | 'concentric' | 'breadthfirst';

const LAYOUTS: Array<{ id: LayoutName; label: string }> = [
  // "Structure" is fcose with compound tiling: folders drawn as boxes holding their files.
  { id: 'fcose', label: 'Structure' },
  { id: 'dagre', label: 'Layered' },
  { id: 'breadthfirst', label: 'Tree' },
  { id: 'concentric', label: 'Concentric' },
];

/**
 * Below this many nodes every node is labelled; above it only the best-connected are.
 *
 * Labelling everything in a large graph turns the canvas into unreadable noise, and
 * labelling nothing leaves coloured dots that say nothing at all. The nodes worth reading
 * at a glance are the ones carrying the structure.
 */
const LABEL_EVERY_NODE_BELOW = 150;
const MAX_LABELLED_NODES = 80;

const EDGE_FILTERS: Array<{ id: EdgeType; label: string }> = [
  { id: 'import', label: 'Imports' },
  { id: 're-export', label: 'Re-exports' },
  { id: 'dynamic-import', label: 'Dynamic' },
  { id: 'require', label: 'require()' },
  { id: 'call', label: 'Calls' },
];

/**
 * Colours nodes by their top-level folder so a monorepo reads as distinct regions rather than
 * one undifferentiated mass. Hues come from a hash of the folder name, so a given folder keeps
 * the same colour between sessions without anything being stored.
 */
function folderOf(path: string): string {
  const segments = (path ?? '').split('/');
  if (segments.length <= 1) return '(root)';
  // Two levels for monorepo layouts like apps/web, one otherwise.
  if ((segments[0] === 'apps' || segments[0] === 'packages') && segments.length > 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] as string;
}

export type ColorMode = 'none' | 'folder' | 'community';

const FOLDER_COLORS_KEY = 'tracedeck.graph-folder-colors';

/**
 * The neutral every node wears until someone asks for colour.
 *
 * A dependency graph that arrives pre-painted in nine hues spends its whole colour budget
 * before the reader has asked a question. Structure carries the meaning by default; colour
 * is something you turn on to answer a specific question, and it can be your own.
 */
function neutralTone(dark: boolean): string {
  return dark ? 'hsl(215, 16%, 34%)' : 'hsl(215, 16%, 82%)';
}

/** Top-level directory of a path, which is the unit a colour is assigned to. */
function topFolderOf(path: string): string {
  const first = path.split('#')[0]!.split('/').filter((part) => part.length > 0)[0];
  return first ?? '(root)';
}

/** A stable default hue per directory, used until the user picks something deliberate. */
function directoryColor(folder: string, dark: boolean): string {
  let hash = 0;
  for (let index = 0; index < folder.length; index += 1) {
    hash = (hash * 31 + folder.charCodeAt(index)) % 360;
  }
  const hue = Math.round((hash * 137.508) % 360);
  return dark ? `hsl(${hue}, 42%, 46%)` : `hsl(${hue}, 45%, 62%)`;
}

/**
 * Resolves any CSS colour to the `#rrggbb` an `<input type="color">` requires.
 *
 * Defaults are generated as `hsl()`, which the colour input silently rejects and replaces
 * with black, so every swatch would have shown black until it was touched.
 */
function toHex(color: string): string {
  if (color.startsWith('#')) return color;
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return '#808080';
  probe.fillStyle = color;
  const resolved = probe.fillStyle;
  return typeof resolved === 'string' && resolved.startsWith('#') ? resolved : '#808080';
}

function loadFolderColors(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLDER_COLORS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The folder node a path belongs to, or null when the file sits at the project root. */
function parentFolderOf(path: string): string | null {
  const parts = path.split('#')[0]!.split('/').filter((part) => part.length > 0);
  parts.pop();
  return parts.length === 0 ? null : folderNodeId(parts.join('/'));
}

/** Folders are scaffolding, so they read as structure rather than as another community. */
function folderTone(dark: boolean): string {
  return dark ? 'hsl(226, 14%, 52%)' : 'hsl(226, 12%, 58%)';
}

/**
 * Colours a node by the community it belongs to rather than the folder it sits in.
 *
 * Hues step by the golden angle so that consecutive communities land far apart on the wheel
 * and stay distinguishable well past the handful of groups a folder palette could separate.
 */
function communityColor(community: number, dark: boolean): string {
  const hue = Math.round((community * 137.508) % 360);
  // Commas, not spaces: Cytoscape cannot parse the modern hsl() syntax.
  return dark ? `hsl(${hue}, 62%, 58%)` : `hsl(${hue}, 65%, 45%)`;
}

type GraphPalette = ReturnType<typeof readPalette>;

function readPalette() {
  const surface0 = tokenColor('surface-0');
  return {
    surface0,
    nodeBorder: tokenColor('surface-4'),
    nodeText: tokenColor('ink'),
    canvasText: surface0,
    entry: tokenColor('risk-low'),
    cycle: tokenColor('risk-crit'),
    selected: tokenColor('brand'),
    dependency: tokenColor('risk-med'),
    dependent: tokenColor('brand'),
    edge: tokenColor('surface-4'),
    unresolved: tokenColor('ink-faint'),
    added: tokenColor('risk-low'),
    removed: tokenColor('risk-crit'),
    baseline: tokenColor('ink-muted'),
    target: tokenColor('brand'),
  };
}

function buildStyle(colors: GraphPalette): cytoscape.StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        // A labelled box, not a dot with a caption. A dot has to be decoded against a
        // legend before it says anything; a box says what it is at the size it is drawn.
        // The node grows to fit its own text, so nothing is ever clipped or overlapped.
        'background-color': 'data(color)',
        'background-opacity': 1,
        'border-width': 1,
        'border-color': colors.nodeBorder,
        'border-opacity': 0.9,
        label: 'data(label)',
        color: colors.nodeText,
        'font-size': 11,
        'font-family': 'ui-monospace, Menlo, Consolas, monospace',
        'min-zoomed-font-size': 5,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-max-width': '220px',
        'text-wrap': 'ellipsis',
        width: 'label',
        height: 'label',
        padding: '7px',
        shape: 'round-rectangle',
        'transition-property': 'opacity, border-width, background-opacity',
        'transition-duration': 140,
      },
    },
    // Shape carries the node kind. Colour is already spent on community and border on
    // state, so shape is the only channel left that reads at a glance without a click.
    { selector: 'node[nodeType = "symbol"]', style: { shape: 'diamond' } },
    {
      selector: 'node[nodeType = "folder"]',
      style: {
        shape: 'round-rectangle',
        'background-color': colors.surface0,
        'background-opacity': 0.55,
        'border-color': colors.nodeBorder,
        'border-width': 1.5,
        'border-opacity': 0.9,
        label: 'data(label)',
        'font-size': 12,
        'font-weight': 'bold',
        color: colors.nodeText,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -4,
        'min-zoomed-font-size': 4,
        'text-background-opacity': 0,
        padding: '14px',
        'z-index': 1,
      },
    },
    {
      selector: 'node[isEntry = 1]',
      style: { 'border-color': colors.entry, 'border-width': 3 },
    },
    {
      selector: 'node[inCycle = 1]',
      style: { 'border-color': colors.cycle, 'border-width': 3, 'border-style': 'double' },
    },
    {
      // A gathered node keeps its community colour and gains a ring, so a multi-selection
      // reads as "these ones" without hiding what the colours were saying.
      selector: 'node.multi',
      style: {
        label: 'data(label)',
        'min-zoomed-font-size': 0,
        'border-color': colors.selected,
        'border-width': 4,
        'border-style': 'solid',
        'border-opacity': 1,
        'z-index': 28,
      },
    },
    {
      selector: 'node.selected',
      style: {
        label: 'data(label)',
        'background-color': colors.selected,
        'background-opacity': 1,
        'border-color': colors.selected,
        'border-width': 4,
        color: colors.nodeText,
        'font-size': 11,
        'font-weight': 'bold',
        'min-zoomed-font-size': 0,
        'z-index': 30,
      },
    },
    {
      selector: 'node.dependent',
      style: { 'border-color': colors.dependent, 'border-width': 3, 'background-opacity': 0.5, 'z-index': 20 },
    },
    {
      selector: 'node.dependency',
      style: { 'border-color': colors.dependency, 'border-width': 3, 'background-opacity': 0.5, 'z-index': 20 },
    },
    { selector: 'node.faded', style: { opacity: 0.12 } },
    { selector: 'node.blast', style: { 'border-color': colors.selected, 'border-width': 4, 'z-index': 25 } },
    { selector: 'node.hidden', style: { display: 'none' } },
    {
      // Containment: the branch itself. Drawn as a taxi elbow so the tree reads as a tree
      // rather than as a fan of diagonals, which is what a straight bezier produces once a
      // folder has more than a handful of children.
      selector: 'edge[structural = 1]',
      style: {
        width: 1.4,
        'line-color': colors.nodeBorder,
        'line-opacity': 0.9,
        'curve-style': 'taxi',
        'taxi-direction': 'rightward',
        'taxi-turn': '38%',
        'taxi-turn-min-distance': 12,
        'target-arrow-shape': 'none',
        'z-index': 1,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1,
        'line-color': colors.edge,
        'line-opacity': 0.55,
        'target-arrow-color': colors.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.6,
        'curve-style': 'bezier',
        'transition-property': 'opacity, width, line-color',
        'transition-duration': 140,
      },
    },
    {
      // Import edges are evidence layered over the tree, not the thing being laid out, so
      // they stay quiet until a selection brings the relevant ones forward.
      selector: 'edge[structural = 0]',
      style: { 'line-opacity': 0.18, 'curve-style': 'unbundled-bezier', 'control-point-distances': [-28], 'control-point-weights': [0.5] },
    },
    { selector: 'edge.importsHidden', style: { display: 'none' } },
    {
      selector: 'edge[unresolved = 1]',
      style: { 'line-style': 'dashed', 'line-color': colors.unresolved },
    },
    { selector: 'edge[edgeType = "dynamic-import"]', style: { 'line-style': 'dotted' } },
    {
      selector: 'edge.incoming',
      style: {
        width: 2.2,
        'line-color': colors.dependent,
        'target-arrow-color': colors.dependent,
        'line-opacity': 1,
        'z-index': 25,
      },
    },
    {
      selector: 'edge.outgoing',
      style: {
        width: 2.2,
        'line-color': colors.dependency,
        'target-arrow-color': colors.dependency,
        'line-opacity': 1,
        'z-index': 25,
      },
    },
    { selector: 'edge.faded', style: { opacity: 0.04 } },
    { selector: 'edge.blast', style: { width: 2.4, 'line-color': colors.selected, 'target-arrow-color': colors.selected, 'line-opacity': 1 } },
    { selector: 'edge.hidden', style: { display: 'none' } },
    {
      selector: 'node.added',
      style: { 'border-color': colors.added, 'background-color': colors.added, 'background-opacity': 1 },
    },
    {
      selector: 'node.removed',
      style: { 'border-color': colors.removed, 'background-color': colors.removed, 'background-opacity': 1 },
    },
    { selector: 'node.baseline', style: { 'border-color': colors.baseline, 'border-style': 'dashed' } },
    { selector: 'node.target', style: { 'border-color': colors.target } },
    { selector: 'edge.added', style: { 'line-color': colors.added, 'target-arrow-color': colors.added } },
    {
      selector: 'edge.removed',
      style: { 'line-color': colors.removed, 'target-arrow-color': colors.removed, 'line-style': 'dashed' },
    },
    {
      selector: 'edge.baseline',
      style: { 'line-color': colors.baseline, 'target-arrow-color': colors.baseline, 'line-style': 'dashed' },
    },
    { selector: 'edge.target', style: { 'line-color': colors.target, 'target-arrow-color': colors.target } },
  ];
}

function layoutOptions(name: LayoutName, nodeCount: number): LayoutOptions {
  const base = { animate: false, fit: true, padding: 60 };

  if (name === 'fcose') {
    return {
      ...base,
      name: 'fcose',
      quality: nodeCount > 600 ? 'draft' : 'default',
      // Deterministic: the same graph must lay out the same way every time, or a rescan
      // rearranges a picture the reader has already learned.
      randomize: false,
      // Files are tiled inside their folder box rather than pushed around by force, which
      // is what makes a folder read as a container with contents instead of a cloud.
      tile: true,
      tilingPaddingVertical: 6,
      tilingPaddingHorizontal: 6,
      nodeSeparation: 90,
      packComponents: true,
      nodeRepulsion: () => 6000,
      idealEdgeLength: () => 70,
      edgeElasticity: () => 0.35,
      gravity: 0.25,
      gravityRange: 3.2,
      gravityCompound: 1.4,
      numIter: nodeCount > 600 ? 1200 : 2500,
    } as unknown as LayoutOptions;
  }
  if (name === 'dagre') {
    // Wider ranks and more space between siblings: the branch structure is the point, and
    // it disappears when ranks are packed tightly enough for edges to overlap nodes.
    return {
      ...base,
      name: 'dagre',
      rankDir: 'LR',
      nodeSep: 34,
      rankSep: 130,
      edgeSep: 12,
      ranker: 'tight-tree',
    } as unknown as LayoutOptions;
  }
  if (name === 'concentric') {
    return {
      ...base,
      name: 'concentric',
      concentric: (node: cytoscape.NodeSingular) => node.degree(false),
      levelWidth: () => 3,
      minNodeSpacing: 18,
    } as LayoutOptions;
  }
  return { ...base, name: 'breadthfirst', directed: true, spacingFactor: 1.1 } as LayoutOptions;
}

function reviewClassFor(meta: { side?: 'baseline' | 'target'; delta?: 'added' | 'removed' }): string | undefined {
  const classes: string[] = [];
  if (meta.side) classes.push(meta.side);
  if (meta.delta) classes.push(meta.delta);
  return classes.length > 0 ? classes.join(' ') : undefined;
}

function toElements(
  payload: GraphPayload,
  dark: boolean,
  detected: { communityById: ReadonlyMap<string, number>; communities: readonly Community[] },
  colorMode: ColorMode,
  folderColors: Record<string, string>,
  nodeClasses?: ReadonlyMap<string, string | undefined>,
  edgeClasses?: ReadonlyMap<string, string | undefined>,
): ElementDefinition[] {
  const toneFor = (path: string, community: number): string => {
    if (colorMode === 'community') return communityColor(community, dark);
    if (colorMode === 'folder') {
      const top = topFolderOf(path);
      return folderColors[top] ?? directoryColor(top, dark);
    }
    return neutralTone(dark);
  };

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const graphEdges = payload.edges ?? [];
  const graphNodes = payload.nodes ?? [];
  for (const edge of graphEdges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  const degreeOf = (id: string): number => (incoming.get(id) ?? 0) + (outgoing.get(id) ?? 0);
  const communityLabels = new Map(detected.communities.map((item) => [item.id, item.label]));

  // Which nodes carry a visible label. Sorted by connectivity, then by path so the choice is
  // stable across rescans rather than depending on the order rows came back in.
  const labelled = new Set<string>();
  if (graphNodes.length <= LABEL_EVERY_NODE_BELOW) {
    for (const node of graphNodes) labelled.add(node.id);
  } else {
    const ranked = [...graphNodes].sort((left, right) => {
      const delta = degreeOf(right.id) - degreeOf(left.id);
      return delta !== 0 ? delta : (left.path ?? '').localeCompare(right.path ?? '');
    });
    for (const node of ranked.slice(0, MAX_LABELLED_NODES)) labelled.add(node.id);
  }

  const nodes: ElementDefinition[] = graphNodes.map((node) => {
    const importedBy = incoming.get(node.id) ?? 0;
    const imports = outgoing.get(node.id) ?? 0;
    const connections = importedBy + imports;
    // Area grows with connectivity but is damped, so one hub cannot dwarf everything else.
    const size = Math.round(Math.min(60, 18 + Math.sqrt(connections) * 7));
    const folder = folderOf(node.path ?? '');
    const community = detected.communityById.get(node.id) ?? 0;

    return {
      data: {
        id: node.id,
        // Containment is expressed as parentage, not as an edge. A folder then draws as a
        // labelled box with its files inside it, which is what "folders with their files"
        // actually looks like; wiring 189 leaves to their parents instead produced a tall
        // thin comb that fitted to nothing readable.
        parent: parentFolderOf(node.path ?? '') ?? undefined,
        label: node.label,
        // Cytoscape renders whatever this holds, so an unlabelled node carries an empty
        // string rather than needing a second style rule to hide its text.
        labelText: labelled.has(node.id) ? node.label : '',
        path: node.path,
        nodeType: node.type,
        symbolKind: node.symbolKind ?? '',
        folder,
        community,
        communityLabel: communityLabels.get(community) ?? '',
        color: toneFor(node.path ?? '', community),
        size,
        degree: connections,
        imports,
        importedBy,
        inCycle: node.inCycle ? 1 : 0,
        isEntry: node.isEntryPoint ? 1 : 0,
      },
      classes: nodeClasses?.get(node.id),
    };
  });

  const edges: ElementDefinition[] = graphEdges.map((edge) => ({
    data: {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      edgeType: edge.edgeType,
      unresolved: edge.unresolved ? 1 : 0,
      typeOnly: edge.typeOnly ? 1 : 0,
      structural: 0,
    },
    classes: edgeClasses?.get(edge.id),
  }));

  // The folder hierarchy, rebuilt from the paths and added as real nodes.
  //
  // An import graph laid out hierarchically produces a diagonal cascade, because its ranks
  // are import depth and almost every file links sideways to several others. A project's
  // folder tree is an actual tree — one parent each, no cycles — so it is the thing that can
  // be drawn as clean branches. Imports are then overlaid on that structure rather than
  // being asked to define it.
  const folderNodes: ElementDefinition[] = [];
  const descendants = new Map<string, number>();
  const seenFolders = new Set<string>();

  const segmentsOf = (path: string): string[] =>
    path.split('#')[0]!.split('/').filter((part) => part.length > 0);

  // Count first, so a folder can be sized by how much it holds.
  for (const node of graphNodes) {
    const parts = segmentsOf(node.path ?? '');
    parts.pop();
    let prefix = '';
    for (const part of parts) {
      prefix = prefix.length === 0 ? part : `${prefix}/${part}`;
      descendants.set(prefix, (descendants.get(prefix) ?? 0) + 1);
    }
  }

  const ensureFolder = (path: string, parentId: string | null): string => {
    const id = folderNodeId(path);
    if (!seenFolders.has(id)) {
      seenFolders.add(id);
      const held = descendants.get(path) ?? 1;
      folderNodes.push({
        data: {
          id,
          parent: parentId ?? undefined,
          label: path.split('/').pop() ?? path,
          labelText: path.split('/').pop() ?? path,
          path,
          nodeType: 'folder',
          symbolKind: '',
          folder: path,
          community: -1,
          communityLabel: '',
          color: folderTone(dark),
          size: Math.round(Math.min(52, 22 + Math.sqrt(held) * 5)),
          degree: held,
          imports: 0,
          importedBy: held,
          inCycle: 0,
          isEntry: 0,
        },
      });
    }
    return id;
  };

  for (const node of graphNodes) {
    const parts = segmentsOf(node.path ?? '');
    parts.pop();

    let parentId: string | null = null;
    let prefix = '';
    for (const part of parts) {
      prefix = prefix.length === 0 ? part : `${prefix}/${part}`;
      parentId = ensureFolder(prefix, parentId);
    }

  }

  return [...folderNodes, ...nodes, ...edges];
}

/**
 * What the pointer is currently over, for the readout card.
 *
 * This is a DOM overlay driven by node data, never a restyle of the canvas. The distinction
 * matters: highlighting a neighbourhood on hover repainted the whole graph on every node
 * the pointer crossed, which is the photosensitivity hazard that behaviour was removed for.
 * Reading a card costs one small element appearing beside the cursor and nothing else.
 */
interface GraphHover {
  x: number;
  y: number;
  label: string;
  path: string;
  nodeType: string;
  symbolKind: string;
  communityLabel: string;
  imports: number;
  importedBy: number;
  isEntry: boolean;
  inCycle: boolean;
}

interface SavedGraphView {
  name: string;
  folderPrefix: string;
  edgeTypes: EdgeType[];
  hideTypeOnly: boolean;
  collapseBarrels: boolean;
  layout: LayoutName;
}

const SAVED_VIEWS_KEY = 'tracedeck.graph-views';

function loadSavedViews(): SavedGraphView[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) ?? '[]') as SavedGraphView[];
    return Array.isArray(parsed) ? parsed.slice(0, 12) : [];
  } catch {
    return [];
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function graphToSvg(cy: Core): string {
  const bb = cy.elements().boundingBox();
  const pad = 48;
  const width = Math.max(1, bb.w + pad * 2);
  const height = Math.max(1, bb.h + pad * 2);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="${bb.x1 - pad} ${bb.y1 - pad} ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="transparent"/>',
  ];
  cy.edges().forEach((edge) => {
    const source = edge.source().position();
    const target = edge.target().position();
    parts.push(
      `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke="#7a8494" stroke-width="1"/>`,
    );
  });
  cy.nodes().forEach((node) => {
    const position = node.position();
    const color = String(node.data('color') ?? '#7a8494');
    const radius = Number(node.data('size') ?? 18) / 2;
    parts.push(
      `<circle cx="${position.x}" cy="${position.y}" r="${radius}" fill="${escapeXml(color)}" fill-opacity="0.8"/>`,
    );
    parts.push(
      `<text x="${position.x}" y="${position.y + radius + 10}" font-size="9" text-anchor="middle" fill="#9aa4b5">${escapeXml(String(node.data('label') ?? ''))}</text>`,
    );
  });
  parts.push('</svg>');
  return parts.join('');
}

export function GraphView(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  const project = useAppStore((state) => state.currentProject);
  const stats = useAppStore((state) => state.stats);
  const selectedNodeId = useUiStore((state) => state.selectedNodeId);
  const multiSelectedNodeIds = useUiStore((state) => state.multiSelectedNodeIds);
  const selectNode = useUiStore((state) => state.selectNode);
  const openCode = useUiStore((state) => state.openCode);
  const highlightNodeIds = useUiStore((state) => state.highlightNodeIds);
  const graphSliceEdgeTypes = useUiStore((state) => state.graphSliceEdgeTypes);
  const setGraphSliceEdgeTypes = useUiStore((state) => state.setGraphSliceEdgeTypes);
  const reviewGraphOverlay = useUiStore((state) => state.reviewGraphOverlay);
  const clearReviewContext = useUiStore((state) => state.clearReviewContext);
  const themeRevision = useUiStore((state) => state.themeRevision);
  const themeId = useUiStore((state) => state.theme);
  const isDark = !themeId.includes('light');

  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [hover, setHover] = useState<GraphHover | null>(null);
  const [loading, setLoading] = useState(false);
  const [layout, setLayout] = useState<LayoutName>('fcose');
  const [legendOpen, setLegendOpen] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>('none');
  const [folderColors, setFolderColors] = useState<Record<string, string>>(() =>
    loadFolderColors(),
  );
  const [edgeTypes, setEdgeTypes] = useState<Set<EdgeType>>(
    new Set(['import', 're-export', 'dynamic-import', 'require']),
  );
  const [includeUnresolved, setIncludeUnresolved] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [folderPrefix, setFolderPrefix] = useState('');
  const [search, setSearch] = useState('');
  const [hideTypeOnly, setHideTypeOnly] = useState(false);
  const [showImports, setShowImports] = useState(true);
  const [collapseBarrels, setCollapseBarrels] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedGraphView[]>(() => loadSavedViews());
  const [viewName, setViewName] = useState('');
  const [minimap, setMinimap] = useState<{
    nodes: Array<{ x: number; y: number; color: string }>;
    view: { x: number; y: number; w: number; h: number };
  } | null>(null);

  // Only the focus root belongs in the query key. Selecting a node while focus mode is off
  // must not refetch or re-lay-out the graph — that was what made clicking feel broken.
  const focusRoot = focusMode && !reviewGraphOverlay ? selectedNodeId : null;

  const effectivePayload = useMemo(
    () => reviewGraphOverlay?.payload ?? payload,
    [reviewGraphOverlay, payload],
  );
  const isOverlayActive = Boolean(reviewGraphOverlay);

  const topFolders = useMemo(() => {
    const set = new Set<string>();
    for (const node of effectivePayload?.nodes ?? []) set.add(topFolderOf(node.path));
    return [...set].sort();
  }, [effectivePayload]);

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const node of effectivePayload?.nodes ?? []) set.add(folderOf(node.path));
    return [...set].sort();
  }, [effectivePayload]);

  const load = useCallback(async () => {
    if (!project || reviewGraphOverlay) return;
    setLoading(true);
    try {
      const result = await invoke('graph:query', {
        projectId: project.id,
        edgeTypes: graphSliceEdgeTypes ?? [...edgeTypes],
        includeUnresolved,
        nodeLimit: GRAPH_NODE_SOFT_LIMIT,
        ...(folderPrefix ? { folderPrefix } : {}),
        ...(focusRoot ? { focusNodeId: focusRoot, focusDepth: 2 } : {}),
        ...(graphSliceEdgeTypes?.includes('call')
          ? { nodeTypes: ['file', 'symbol'] as NodeType[] }
          : {}),
      });
      setPayload(result);
    } catch {
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [
    project,
    edgeTypes,
    includeUnresolved,
    folderPrefix,
    focusRoot,
    graphSliceEdgeTypes,
    reviewGraphOverlay,
  ]);

  useEffect(() => {
    if (reviewGraphOverlay) return;
    void load();
  }, [load, stats, reviewGraphOverlay]);

  useEffect(() => {
    if (!containerRef.current || cyRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      // The default of 1 felt sluggish; this makes a wheel notch cover real ground without
      // overshooting on a trackpad.
      wheelSensitivity: 2.2,
      minZoom: 0.04,
      maxZoom: 4,
      // Shift-drag sweeps a box. Cytoscape's own selection model is used only to read what
      // the box caught; the set the app acts on is `multiSelectedNodeIds`.
      boxSelectionEnabled: true,
      style: buildStyle(readPalette()),
    });

    cy.on('tap', 'node', (event) => {
      const store = useUiStore.getState();
      if (store.reviewGraphOverlay) {
        store.clearMultiSelect();
        return;
      }
      const id = event.target.id() as string;
      const original = event.originalEvent as MouseEvent | undefined;
      // metaKey so the shortcut works the same way on macOS.
      const additive = original?.ctrlKey === true || original?.metaKey === true;

      if (additive && original?.shiftKey === true) {
        const store = useUiStore.getState();
        // The clicked node counts as part of the set, so the shortcut works even when it is
        // the only thing wanted and nothing was gathered first.
        const gathered = store.multiSelectedNodeIds.includes(id)
          ? store.multiSelectedNodeIds
          : [...store.multiSelectedNodeIds, id];
        const paths = gathered
          .map((nodeId) => parseNodeId(nodeId))
          .filter((parsed) => parsed !== null && parsed.type !== 'folder')
          .map((parsed) => parsed!.path);
        store.openPaths(paths);
        return;
      }

      if (additive) {
        useUiStore.getState().toggleMultiSelect(id);
        return;
      }

      useUiStore.getState().clearMultiSelect();
      selectNode(id);
    });
    // Whether the sweep that is starting should also open what it catches. Read at the
    // start of the drag, because by the time the box closes the keys may already be up.
    let sweepOpens = false;
    // Set while a sweep finishes. Cytoscape should treat a drag as a drag rather than a
    // tap, but if a core tap does arrive on mouse-up it would clear the set the sweep just
    // built — the feature would look like it did nothing.
    let sweepJustEnded = false;

    cy.on('boxstart', (event) => {
      const original = event.originalEvent as MouseEvent | undefined;
      sweepOpens = original?.ctrlKey === true || original?.metaKey === true;
      // A leftover tap-selection would otherwise be read as part of the box's catch.
      cy.nodes().unselect();
    });

    cy.on('boxend', () => {
      if (useUiStore.getState().reviewGraphOverlay) {
        cy.nodes(':selected').unselect();
        return;
      }
      const caught = cy.nodes(':selected');
      const ids = caught.map((node) => node.id() as string);
      cy.nodes().unselect();
      if (ids.length === 0) return;

      const store = useUiStore.getState();
      store.addToMultiSelect(ids);

      sweepJustEnded = true;
      setTimeout(() => {
        sweepJustEnded = false;
      }, 0);

      if (!sweepOpens) return;
      const paths = [...new Set([...store.multiSelectedNodeIds, ...ids])]
        .map((nodeId) => parseNodeId(nodeId))
        .filter((parsed) => parsed !== null && parsed.type !== 'folder')
        .map((parsed) => parsed!.path);
      store.openPaths(paths);
    });

    cy.on('dbltap', 'node', (event) => {
      if (useUiStore.getState().reviewGraphOverlay) return;
      const parsed = parseNodeId(event.target.id() as string);
      if (parsed && parsed.type !== 'folder') openCode(parsed.path);
    });
    cy.on('tap', (event) => {
      if (event.target !== cy || sweepJustEnded) return;
      const store = useUiStore.getState();
      if (store.reviewGraphOverlay) {
        store.clearMultiSelect();
        return;
      }
      store.clearMultiSelect();
      selectNode(null);
    });
    // Hovering shows a readout and changes nothing on the canvas. Highlighting a
    // neighbourhood on mouseover faded and unfaded the whole graph every time the pointer
    // crossed a node, which is a full-screen flash several times a second. Clicking still
    // highlights, and it holds until cleared.
    cy.on('mouseover', 'node', (event) => {
      const node = event.target as cytoscape.NodeSingular;
      const point = node.renderedPosition();
      setHover({
        x: point.x,
        y: point.y - node.renderedHeight() / 2,
        label: String(node.data('label') ?? ''),
        path: String(node.data('path') ?? ''),
        nodeType: String(node.data('nodeType') ?? 'file'),
        symbolKind: String(node.data('symbolKind') ?? ''),
        communityLabel: String(node.data('communityLabel') ?? ''),
        imports: Number(node.data('imports') ?? 0),
        importedBy: Number(node.data('importedBy') ?? 0),
        isEntry: node.data('isEntry') === 1,
        inCycle: node.data('inCycle') === 1,
      });
    });
    cy.on('mouseout', 'node', () => setHover(null));
    // The card is placed in screen space, so any viewport move would strand it.
    cy.on('pan zoom', () => setHover(null));


    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [selectNode, openCode]);

  // A theme swap only needs new colours; elements and viewport stay put.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style(buildStyle(readPalette()));
    cy.nodes().forEach((node) => {
      if (node.data('nodeType') === 'folder') return;
      const community = (node.data('community') as number) ?? 0;
      const path = String(node.data('path') ?? '');
      const top = topFolderOf(path);
      node.data(
        'color',
        colorMode === 'community'
          ? communityColor(community, isDark)
          : colorMode === 'folder'
            ? (folderColors[top] ?? directoryColor(top, isDark))
            : neutralTone(isDark),
      );
    });
  }, [themeRevision, isDark, colorMode, folderColors]);

  // Rebuild elements only when the data actually changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !effectivePayload) return;

    const nodeClasses = reviewGraphOverlay
      ? new Map<string, string | undefined>(
          Object.entries(reviewGraphOverlay.nodeMeta).map(([id, meta]) => [id, reviewClassFor(meta)]),
        )
      : undefined;
    const edgeClasses = reviewGraphOverlay
      ? new Map<string, string | undefined>(
          Object.entries(reviewGraphOverlay.edgeMeta).map(([id, meta]) => [id, reviewClassFor(meta)]),
        )
      : undefined;

    cy.batch(() => {
      cy.elements().remove();
      const sourceEdges = effectivePayload.edges ?? [];
      const sourceNodes = effectivePayload.nodes ?? [];
      const filtered: GraphPayload = {
        ...effectivePayload,
        edges: sourceEdges.filter((edge) => {
          if (hideTypeOnly && edge.typeOnly) return false;
          return true;
        }),
        nodes: collapseBarrels
          ? sourceNodes.filter((node) => !/(?:^|\/)index\.[cm]?[jt]sx?$/.test(node.path ?? ''))
          : sourceNodes,
      };
      if (collapseBarrels) {
        const visible = new Set(filtered.nodes.map((node) => node.id));
        filtered.edges = filtered.edges.filter(
          (edge) => visible.has(edge.source) && visible.has(edge.target),
        );
      }
      // Grouping is computed from what is actually on screen, so filtering to one folder
      // regroups that folder's files rather than showing a slice of a partition it is no
      // longer part of.
      const detected = detectCommunities(
        filtered.nodes.map((node) => node.id),
        filtered.edges,
      );
      setCommunities(detected.communities);
      cy.add(
        toElements(filtered, isDark, detected, colorMode, folderColors, nodeClasses, edgeClasses),
      );
    });
    // Positioning uses containment alone. Feeding import edges to the layout is exactly what
    // bent the picture into a diagonal: every edge pulls its endpoints together, and a file
    // importing six others is pulled six ways at once. Laying out nodes only lets the
    // compound packing decide the shape, so the folder structure is what you see.
    cy.nodes().layout(layoutOptions(layout, (effectivePayload.nodes ?? []).length)).run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    effectivePayload,
    layout,
    hideTypeOnly,
    collapseBarrels,
    colorMode,
    folderColors,
    reviewGraphOverlay,
    isDark,
  ]);

  // Import edges are shown or hidden with a class rather than by rebuilding, so toggling
  // them never re-runs the layout and never moves the tree the reader is looking at.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const imports = cy.edges('[structural = 0]');
    if (showImports) imports.removeClass('importsHidden');
    else imports.addClass('importsHidden');
  }, [showImports, effectivePayload]);

  // Rings the gathered nodes. Kept apart from the selection highlight below so that adding
  // to the set does not recompute a neighbourhood on every ctrl-click.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const wanted = new Set(multiSelectedNodeIds);
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const marked = wanted.has(node.id());
        if (marked === node.hasClass('multi')) return;
        if (marked) node.addClass('multi');
        else node.removeClass('multi');
      });
    });
  }, [multiSelectedNodeIds, effectivePayload]);

  // Highlighting is a pure class swap: no refetch, no relayout, viewport untouched.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.elements().removeClass('selected dependency dependent incoming outgoing faded');

      if (!selectedNodeId) return;
      const node = cy.getElementById(selectedNodeId);
      if (node.empty()) return;

      const incoming = node.incomers('edge');
      const outgoing = node.outgoers('edge');
      const neighbourhood = node.union(node.incomers()).union(node.outgoers());

      cy.elements().difference(neighbourhood).addClass('faded');
      node.addClass('selected');
      node.incomers('node').addClass('dependent');
      node.outgoers('node').addClass('dependency');
      incoming.addClass('incoming');
      outgoing.addClass('outgoing');
    });
  }, [selectedNodeId, effectivePayload]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass('blast');
    cy.edges().removeClass('blast');
    for (const id of highlightNodeIds) {
      cy.getElementById(id).addClass('blast');
    }
    cy.edges().forEach((edge) => {
      if (
        highlightNodeIds.includes(edge.source().id()) &&
        highlightNodeIds.includes(edge.target().id())
      ) {
        edge.addClass('blast');
      }
    });
  }, [highlightNodeIds, effectivePayload]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const update = (): void => {
      const bb = cy.elements().boundingBox();
      if (bb.w <= 0 || bb.h <= 0) {
        setMinimap(null);
        return;
      }
      const extent = cy.extent();
      setMinimap({
        nodes: cy.nodes().map((node) => ({
          x: (node.position('x') - bb.x1) / bb.w,
          y: (node.position('y') - bb.y1) / bb.h,
          color: String(node.data('color') ?? '#888'),
        })),
        view: {
          x: (extent.x1 - bb.x1) / bb.w,
          y: (extent.y1 - bb.y1) / bb.h,
          w: (extent.x2 - extent.x1) / bb.w,
          h: (extent.y2 - extent.y1) / bb.h,
        },
      });
    };
    update();
    cy.on('pan zoom layoutstop', update);
    return () => {
      cy.off('pan zoom layoutstop', update);
    };
  }, [effectivePayload, layout]);

  // Dim non-matching nodes as you type rather than yanking the viewport around.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const needle = search.trim().toLowerCase();

    cy.batch(() => {
      cy.elements().removeClass('hidden');
      if (needle.length === 0) return;

      const matches = cy
        .nodes()
        .filter((node) => (node.data('path') as string).toLowerCase().includes(needle));
      cy.nodes().difference(matches).addClass('hidden');
      cy.edges()
        .filter((edge) => !matches.contains(edge.source()) || !matches.contains(edge.target()))
        .addClass('hidden');
    });
  }, [search, effectivePayload]);

  // Zooms about the middle of the viewport. Animating with a `center` option fought the zoom
  // and barely moved the view, so this applies the level directly.
  const zoomBy = (factor: number): void => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({
      level: Math.min(4, Math.max(0.04, cy.zoom() * factor)),
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
    });
  };

  if (!project || !stats || stats.totalFiles === 0) {
    return (
      <EmptyState
        title="No graph to show yet"
        description="Scan a project to build and explore its dependency graph."
      />
    );
  }

  const selectedPath = selectedNodeId ? (parseNodeId(selectedNodeId)?.path ?? null) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter nodes…"
            className="w-40 rounded border border-edge bg-surface-2 py-1 pl-7 pr-2 text-[11px] text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
            style={{ userSelect: 'text' }}
          />
        </div>

        <select
          value={layout}
          onChange={(event) => setLayout(event.target.value as LayoutName)}
          className="rounded border border-edge bg-surface-2 px-1.5 py-1 text-[11px] text-ink focus:border-brand focus:outline-none"
        >
          {LAYOUTS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          value={colorMode}
          onChange={(event) => setColorMode(event.target.value as ColorMode)}
          className="rounded border border-edge bg-surface-2 px-1.5 py-1 text-[11px] text-ink focus:border-brand focus:outline-none"
          title="What the node colour means"
        >
          <option value="none">No colour</option>
          <option value="folder">Colour by directory</option>
          <option value="community">Colour by community</option>
        </select>

        <select
          value={folderPrefix}
          onChange={(event) => setFolderPrefix(event.target.value)}
          disabled={isOverlayActive}
          className="max-w-36 rounded border border-edge bg-surface-2 px-1.5 py-1 text-[11px] text-ink focus:border-brand focus:outline-none"
        >
          <option value="">All folders</option>
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>

        <div className="flex gap-1">
          {EDGE_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() =>
                setEdgeTypes((current) => {
                  const next = new Set(current);
                  if (next.has(filter.id)) next.delete(filter.id);
                  else next.add(filter.id);
                  return next.size === 0 ? new Set([filter.id]) : next;
                })
              }
              disabled={isOverlayActive}
              className={clsx(
                'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                edgeTypes.has(filter.id)
                  ? 'bg-brand/15 text-brand'
                  : 'bg-surface-2 text-ink-faint hover:text-ink',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={includeUnresolved}
            onChange={(event) => setIncludeUnresolved(event.target.checked)}
            disabled={isOverlayActive}
            className="accent-brand"
          />
          Unresolved
        </label>
        <label className="flex items-center gap-1 text-[10px] text-ink-muted">
          <input
            type="checkbox"
            checked={showImports}
            onChange={(event) => setShowImports(event.target.checked)}
            className="accent-brand"
          />
          Imports
        </label>
        <label className="flex items-center gap-1 text-[10px] text-ink-muted">
          <input
            type="checkbox"
            checked={hideTypeOnly}
            onChange={(event) => setHideTypeOnly(event.target.checked)}
            disabled={isOverlayActive}
            className="accent-brand"
          />
          Hide type-only
        </label>
        <label className="flex items-center gap-1 text-[10px] text-ink-muted">
          <input
            type="checkbox"
            checked={collapseBarrels}
            onChange={(event) => setCollapseBarrels(event.target.checked)}
            disabled={isOverlayActive}
            className="accent-brand"
          />
          Collapse barrels
        </label>
        {graphSliceEdgeTypes && (
          <Button size="sm" variant="primary" onClick={() => setGraphSliceEdgeTypes(null)} disabled={isOverlayActive}>
            Clear call slice
          </Button>
        )}
        <input
          value={viewName}
          onChange={(event) => setViewName(event.target.value)}
          placeholder="View name"
          className="w-24 rounded border border-edge bg-surface-2 px-1.5 py-1 text-[10px] text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
          style={{ userSelect: 'text' }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={viewName.trim().length === 0 || isOverlayActive}
          onClick={() => {
            const next: SavedGraphView[] = [
              {
                name: viewName.trim(),
                folderPrefix,
                edgeTypes: [...edgeTypes],
                hideTypeOnly,
                collapseBarrels,
                layout,
              },
              ...savedViews.filter((view) => view.name !== viewName.trim()),
            ].slice(0, 12);
            setSavedViews(next);
            localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next));
            setViewName('');
          }}
        >
          Save view
        </Button>
        {savedViews.length > 0 && (
          <select
            className="max-w-32 rounded border border-edge bg-surface-2 px-1.5 py-1 text-[11px] text-ink"
            defaultValue=""
            disabled={isOverlayActive}
            onChange={(event) => {
              const view = savedViews.find((entry) => entry.name === event.target.value);
              event.currentTarget.selectedIndex = 0;
              if (!view) return;
              setFolderPrefix(view.folderPrefix);
              setEdgeTypes(new Set(view.edgeTypes));
              setHideTypeOnly(view.hideTypeOnly);
              setCollapseBarrels(view.collapseBarrels);
              setLayout(view.layout);
            }}
          >
            <option value="">Saved views</option>
            {savedViews.map((view) => (
              <option key={view.name} value={view.name}>
                {view.name}
              </option>
            ))}
          </select>
        )}

        <Button
          size="sm"
          variant={focusMode ? 'primary' : 'ghost'}
          onClick={() => setFocusMode((value) => !value)}
          disabled={!selectedNodeId || isOverlayActive}
          title="Show only the neighbourhood of the selected node"
        >
          <Crosshair size={11} />
          Focus
        </Button>

        <Button
          size="sm"
          variant="ghost"
          disabled={!selectedPath || isOverlayActive}
          onClick={() => selectedPath && openCode(selectedPath)}
          title="Open this file's source beside the graph"
        >
          <Code2 size={11} />
          Code
        </Button>

        <div className="ml-auto flex items-center gap-1">
          {loading && <Loader2 size={13} className="animate-spin text-ink-faint" />}
          <Button size="sm" variant="ghost" onClick={() => zoomBy(1 / 1.5)} title="Zoom out">
            <ZoomOut size={11} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => zoomBy(1.5)} title="Zoom in">
            <ZoomIn size={11} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => cyRef.current?.fit(undefined, 60)}>
            <Maximize2 size={11} />
            Fit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Export the current graph as PNG"
            onClick={() => {
              const cy = cyRef.current;
              if (!cy) return;
              const png = cy.png({ output: 'base64', full: true, bg: '#00000000' });
              void invoke('system:save-export', {
                defaultFileName: 'tracedeck-graph.png',
                contents: png,
                encoding: 'base64',
              });
            }}
          >
            <Download size={11} />
            PNG
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Export the current graph as SVG"
            onClick={() => {
              const cy = cyRef.current;
              if (!cy) return;
              void invoke('system:save-export', {
                defaultFileName: 'tracedeck-graph.svg',
                contents: graphToSvg(cy),
                encoding: 'utf8',
              });
            }}
          >
            <Download size={11} />
            SVG
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()} title="Reload" disabled={isOverlayActive}>
            <RefreshCcw size={11} />
          </Button>
        </div>
      </div>

      {reviewGraphOverlay && (
        <div className="flex items-center justify-between gap-3 border-b border-edge bg-surface-1 px-3 py-2">
          <p className="text-[11px] text-ink-muted">
            <span className="font-medium text-ink">Review evidence</span>
            {' · '}
            {reviewGraphOverlay.title}
          </p>
          <Button size="sm" variant="ghost" onClick={clearReviewContext}>
            Clear
          </Button>
        </div>
      )}

      {effectivePayload?.truncated && (
        <div className="px-3 pt-2">
          <Warning>
            Showing the {(effectivePayload.nodes ?? []).length} most connected of {effectivePayload.totalNodeCount} files.
            Narrow by folder, or select a node and turn on Focus, to see a complete subgraph.
          </Warning>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {hover ? (
          <div
            className="pointer-events-none absolute z-20 w-64 -translate-x-1/2 -translate-y-full rounded-md border border-edge bg-surface-1 px-2.5 py-2 shadow-lg"
            style={{ left: hover.x, top: hover.y - 10 }}
          >
            <p className="truncate text-[11px] font-semibold text-ink">{hover.label}</p>
            <p className="mono-path truncate text-[10px] text-ink-faint">{hover.path}</p>

            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-edge pt-1.5 text-[10px]">
              <span className="text-ink-muted">
                imports <span className="text-ink">{hover.imports}</span>
              </span>
              <span className="text-ink-muted">
                imported by <span className="text-ink">{hover.importedBy}</span>
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="rounded bg-surface-3 px-1 py-px text-[9px] uppercase tracking-wide text-ink-muted">
                {hover.symbolKind || hover.nodeType}
              </span>
              {hover.communityLabel ? (
                <span className="mono-path truncate text-[9px] text-ink-faint">
                  {hover.communityLabel}
                </span>
              ) : null}
              {hover.isEntry ? (
                <span className="rounded bg-risk-low/20 px-1 py-px text-[9px] text-risk-low">
                  entry point
                </span>
              ) : null}
              {hover.inCycle ? (
                <span className="rounded bg-risk-crit/20 px-1 py-px text-[9px] text-risk-crit">
                  in a cycle
                </span>
              ) : null}
            </div>

            <p className="mt-1 text-[9px] text-ink-faint">Click to inspect · double-click to open</p>
          </div>
        ) : null}

        <div
          className="pointer-events-none absolute bottom-3 right-3 h-24 w-36 overflow-hidden rounded-md border border-edge bg-surface-1/95"
        >
          {minimap && (
            <svg viewBox="0 0 1 1" className="h-full w-full" preserveAspectRatio="none">
              {minimap.nodes.map((node, index) => (
                <circle
                  key={index}
                  cx={node.x}
                  cy={node.y}
                  r="0.012"
                  fill={node.color}
                />
              ))}
              <rect
                x={minimap.view.x}
                y={minimap.view.y}
                width={Math.max(0.04, minimap.view.w)}
                height={Math.max(0.04, minimap.view.h)}
                fill="rgb(var(--brand) / 0.15)"
                stroke="rgb(var(--brand))"
                strokeWidth="0.01"
              />
            </svg>
          )}
        </div>

        <button
          type="button"
          onClick={() => setLegendOpen((open) => !open)}
          className="absolute bottom-3 left-3 z-10 rounded-md border border-edge bg-surface-1/95 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint hover:text-ink"
        >
          {legendOpen ? 'Hide legend' : 'Legend'}
        </button>

        <div
          className={clsx(
            'pointer-events-none absolute bottom-10 left-3 max-w-[15rem] space-y-1 rounded-md border border-edge bg-surface-1/95 px-2.5 py-2',
            !legendOpen && 'hidden',
          )}
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            {colorMode === 'community' ? 'Communities' : 'Directories'}
          </p>

          {colorMode === 'community' ? (
            <div className="flex flex-wrap gap-x-2.5 gap-y-1">
              {communities.slice(0, 8).map((community) => (
                <span key={community.id} className="flex items-center gap-1">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: communityColor(community.id, isDark) }}
                  />
                  <span className="mono-path text-ink-muted">{community.label}</span>
                  <span className="text-[10px] text-ink-faint">{community.nodes.length}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="pointer-events-auto space-y-1">
              {topFolders.slice(0, 10).map((folder) => (
                <label key={folder} className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={toHex(folderColors[folder] ?? directoryColor(folder, isDark))}
                    onChange={(event) => {
                      const next = { ...folderColors, [folder]: event.target.value };
                      setFolderColors(next);
                      localStorage.setItem(FOLDER_COLORS_KEY, JSON.stringify(next));
                      if (colorMode === 'none') setColorMode('folder');
                    }}
                    className="h-3 w-3 cursor-pointer border-0 bg-transparent p-0"
                    title={`Colour for ${folder}`}
                  />
                  <span className="mono-path truncate text-[10px] text-ink-muted">{folder}</span>
                </label>
              ))}
              <p className="pt-0.5 text-[10px] text-ink-faint">
                Nodes are one neutral tone until you choose. Pick a swatch to colour a whole
                directory, or switch the mode above.
              </p>
            </div>
          )}

          <div className="space-y-0.5 border-t border-edge pt-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Shape
            </p>
            <div className="flex flex-wrap gap-x-2.5 gap-y-1">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-ink-muted" />
                <span className="text-[10px] text-ink-muted">File</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rotate-45 bg-ink-muted" />
                <span className="text-[10px] text-ink-muted">Symbol</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-ink-muted" />
                <span className="text-[10px] text-ink-muted">Folder</span>
              </span>
            </div>

            <p className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Lines
            </p>
            <p className="text-[10px] text-ink-muted">
              Solid elbows are the folder tree. Faint curves are imports — untick
              <span className="text-ink"> Imports</span> to read the structure alone.
            </p>

            <p className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Border
            </p>
            {[
              ['Entry point', 'border-risk-low'],
              ['In a cycle', 'border-risk-crit'],
              ['Depends on selected', 'border-brand'],
              ['Selected depends on', 'border-risk-med'],
            ].map(([label, borderClass]) => (
              <div key={label} className="flex items-center gap-1.5">
                <span className={clsx('h-2 w-2 rounded-full border-2 bg-transparent', borderClass)} />
                <span className="text-[10px] text-ink-muted">{label}</span>
              </div>
            ))}
            <p className="pt-0.5 text-[10px] text-ink-faint">
              Colour groups files that depend on each other more than on the rest of the
              project, named after the folder most of them share. Size shows how connected a
              file is. Hover any node for its details; double-click opens its code.
            </p>
            <p className="text-[10px] text-ink-faint">
              <span className="text-ink-muted">Ctrl-click</span> gathers ·{' '}
              <span className="text-ink-muted">Shift-drag</span> sweeps a box ·{' '}
              <span className="text-ink-muted">add Ctrl</span> to open what you gathered
              {multiSelectedNodeIds.length > 0 ? ` · ${multiSelectedNodeIds.length} gathered` : ''}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
