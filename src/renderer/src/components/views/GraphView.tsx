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
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { EdgeType, GraphPayload } from '@shared/types';
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
  { id: 'fcose', label: 'Organic' },
  { id: 'dagre', label: 'Layered' },
  { id: 'concentric', label: 'Concentric' },
  { id: 'breadthfirst', label: 'Tree' },
];

const EDGE_FILTERS: Array<{ id: EdgeType; label: string }> = [
  { id: 'import', label: 'Imports' },
  { id: 're-export', label: 'Re-exports' },
  { id: 'dynamic-import', label: 'Dynamic' },
  { id: 'require', label: 'require()' },
];

/**
 * Colours nodes by their top-level folder so a monorepo reads as distinct regions rather than
 * one undifferentiated mass. Hues come from a hash of the folder name, so a given folder keeps
 * the same colour between sessions without anything being stored.
 */
function folderOf(path: string): string {
  const segments = path.split('/');
  if (segments.length <= 1) return '(root)';
  // Two levels for monorepo layouts like apps/web, one otherwise.
  if ((segments[0] === 'apps' || segments[0] === 'packages') && segments.length > 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] as string;
}

function hueFor(folder: string): number {
  let hash = 0;
  for (let index = 0; index < folder.length; index += 1) {
    hash = (hash * 31 + folder.charCodeAt(index)) % 360;
  }
  // Golden-angle spread keeps neighbouring folder names visually far apart.
  return (hash * 137.508) % 360;
}

function folderColor(folder: string, dark: boolean): string {
  const hue = Math.round(hueFor(folder));
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
  };
}

function buildStyle(colors: GraphPalette): cytoscape.StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        // Folder colour and connectivity-driven size are computed per node at build time.
        'background-color': 'data(color)',
        'background-opacity': 0.75,
        'border-width': 1.5,
        'border-color': 'data(color)',
        'border-opacity': 1,
        label: 'data(label)',
        color: colors.nodeText,
        'font-size': 9,
        'font-family': 'ui-monospace, Menlo, Consolas, monospace',
        // Labels vanish when zoomed out instead of turning the canvas into noise.
        'min-zoomed-font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-max-width': '140px',
        'text-wrap': 'ellipsis',
        width: 'data(size)',
        height: 'data(size)',
        shape: 'ellipse',
        'transition-property': 'opacity, border-width, background-opacity',
        'transition-duration': 140,
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
      selector: 'node.selected',
      style: {
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
    { selector: 'node.hidden', style: { display: 'none' } },
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
    { selector: 'edge.hidden', style: { display: 'none' } },
  ];
}

function layoutOptions(name: LayoutName, nodeCount: number): LayoutOptions {
  const base = { animate: false, fit: true, padding: 60 };

  if (name === 'fcose') {
    return {
      ...base,
      name: 'fcose',
      quality: nodeCount > 600 ? 'draft' : 'default',
      randomize: true,
      nodeRepulsion: () => 9000,
      idealEdgeLength: () => 70,
      edgeElasticity: () => 0.35,
      gravity: 0.3,
      gravityRange: 3.2,
      numIter: nodeCount > 600 ? 1200 : 2500,
    } as unknown as LayoutOptions;
  }
  if (name === 'dagre') {
    return { ...base, name: 'dagre', rankDir: 'LR', nodeSep: 24, rankSep: 90 } as LayoutOptions;
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

function toElements(payload: GraphPayload, dark: boolean): ElementDefinition[] {
  const degree = new Map<string, number>();
  for (const edge of payload.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const nodes: ElementDefinition[] = payload.nodes.map((node) => {
    const connections = degree.get(node.id) ?? 0;
    // Area grows with connectivity but is damped, so one hub cannot dwarf everything else.
    const size = Math.round(Math.min(60, 18 + Math.sqrt(connections) * 7));
    const folder = folderOf(node.path);

    return {
      data: {
        id: node.id,
        label: node.label,
        path: node.path,
        folder,
        color: folderColor(folder, dark),
        size,
        degree: connections,
        inCycle: node.inCycle ? 1 : 0,
        isEntry: node.isEntryPoint ? 1 : 0,
      },
    };
  });

  const edges: ElementDefinition[] = payload.edges.map((edge) => ({
    data: {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      edgeType: edge.edgeType,
      unresolved: edge.unresolved ? 1 : 0,
    },
  }));

  return [...nodes, ...edges];
}

export function GraphView(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  const project = useAppStore((state) => state.currentProject);
  const stats = useAppStore((state) => state.stats);
  const selectedNodeId = useUiStore((state) => state.selectedNodeId);
  const selectNode = useUiStore((state) => state.selectNode);
  const openCode = useUiStore((state) => state.openCode);
  const themeRevision = useUiStore((state) => state.themeRevision);
  const themeId = useUiStore((state) => state.theme);
  const isDark = !themeId.includes('light');

  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [layout, setLayout] = useState<LayoutName>('fcose');
  const [edgeTypes, setEdgeTypes] = useState<Set<EdgeType>>(
    new Set(['import', 're-export', 'dynamic-import', 'require']),
  );
  const [includeUnresolved, setIncludeUnresolved] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [folderPrefix, setFolderPrefix] = useState('');
  const [search, setSearch] = useState('');

  // Only the focus root belongs in the query key. Selecting a node while focus mode is off
  // must not refetch or re-lay-out the graph — that was what made clicking feel broken.
  const focusRoot = focusMode ? selectedNodeId : null;

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const node of payload?.nodes ?? []) set.add(folderOf(node.path));
    return [...set].sort();
  }, [payload]);

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const result = await invoke('graph:query', {
        projectId: project.id,
        edgeTypes: [...edgeTypes],
        includeUnresolved,
        nodeLimit: GRAPH_NODE_SOFT_LIMIT,
        ...(folderPrefix ? { folderPrefix } : {}),
        ...(focusRoot ? { focusNodeId: focusRoot, focusDepth: 2 } : {}),
      });
      setPayload(result);
    } catch {
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [project, edgeTypes, includeUnresolved, folderPrefix, focusRoot]);

  useEffect(() => {
    void load();
  }, [load, stats]);

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
      style: buildStyle(readPalette()),
    });

    cy.on('tap', 'node', (event) => selectNode(event.target.id() as string));
    cy.on('dbltap', 'node', (event) => {
      const parsed = parseNodeId(event.target.id() as string);
      if (parsed && parsed.type !== 'folder') openCode(parsed.path);
    });
    cy.on('tap', (event) => {
      if (event.target === cy) selectNode(null);
    });

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
      node.data('color', folderColor(node.data('folder') as string, isDark));
    });
  }, [themeRevision, isDark]);

  // Rebuild elements only when the data actually changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !payload) return;

    cy.batch(() => {
      cy.elements().remove();
      cy.add(toElements(payload, isDark));
    });
    cy.layout(layoutOptions(layout, payload.nodes.length)).run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, layout]);

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
  }, [selectedNodeId, payload]);

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
  }, [search, payload]);

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
          value={folderPrefix}
          onChange={(event) => setFolderPrefix(event.target.value)}
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
            className="accent-brand"
          />
          Unresolved
        </label>

        <Button
          size="sm"
          variant={focusMode ? 'primary' : 'ghost'}
          onClick={() => setFocusMode((value) => !value)}
          disabled={!selectedNodeId}
          title="Show only the neighbourhood of the selected node"
        >
          <Crosshair size={11} />
          Focus
        </Button>

        <Button
          size="sm"
          variant="ghost"
          disabled={!selectedPath}
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
          <Button size="sm" variant="ghost" onClick={() => void load()} title="Reload">
            <RefreshCcw size={11} />
          </Button>
        </div>
      </div>

      {payload?.truncated && (
        <div className="px-3 pt-2">
          <Warning>
            Showing the {payload.nodes.length} most connected of {payload.totalNodeCount} files.
            Narrow by folder, or select a node and turn on Focus, to see a complete subgraph.
          </Warning>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[15rem] space-y-1 rounded-md border border-edge bg-surface-1/95 px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Regions
          </p>
          <div className="flex flex-wrap gap-x-2.5 gap-y-1">
            {folders.slice(0, 8).map((folder) => (
              <span key={folder} className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: folderColor(folder, isDark) }}
                />
                <span className="mono-path text-ink-muted">{folder}</span>
              </span>
            ))}
          </div>

          <div className="space-y-0.5 border-t border-edge pt-1">
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
              Size shows how connected a file is. Double-click opens its code.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
