import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import clsx from 'clsx';
import { Crosshair, Loader2, Maximize2, RefreshCcw, Search } from 'lucide-react';
import type { EdgeType, GraphPayload } from '@shared/types';
import { GRAPH_NODE_SOFT_LIMIT } from '@shared/constants';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { invoke } from '../../lib/ipc';
import { tokenColor } from '../../lib/theme';
import { Button, EmptyState, Warning } from '../common/ui';

cytoscape.use(dagre);

type LayoutName = 'dagre' | 'breadthfirst' | 'concentric' | 'cose';

const LAYOUTS: Array<{ id: LayoutName; label: string }> = [
  { id: 'dagre', label: 'Layered' },
  { id: 'breadthfirst', label: 'Tree' },
  { id: 'concentric', label: 'Concentric' },
  { id: 'cose', label: 'Organic' },
];

const EDGE_FILTERS: Array<{ id: EdgeType; label: string }> = [
  { id: 'import', label: 'Imports' },
  { id: 're-export', label: 'Re-exports' },
  { id: 'dynamic-import', label: 'Dynamic' },
  { id: 'require', label: 'require()' },
];

/**
 * Cytoscape paints to a canvas, so it cannot use CSS variables directly. The palette is read
 * out of the live theme tokens instead, and re-read whenever the theme changes.
 */
type GraphPalette = ReturnType<typeof readPalette>;

function readPalette() {
  return {
    node: tokenColor('surface-3'),
    nodeBorder: tokenColor('surface-4'),
    nodeText: tokenColor('ink'),
    canvasText: tokenColor('surface-0'),
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
        'background-color': colors.node,
        'border-width': 1,
        'border-color': colors.nodeBorder,
        label: 'data(label)',
        color: colors.nodeText,
        'font-size': '9px',
        'font-family': 'ui-monospace, Menlo, Consolas, monospace',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-max-width': '108px',
        'text-wrap': 'ellipsis',
        width: 'label',
        height: 20,
        padding: '7px',
        shape: 'round-rectangle',
      },
    },
    { selector: 'node[isEntry = 1]', style: { 'border-color': colors.entry, 'border-width': 2 } },
    { selector: 'node[inCycle = 1]', style: { 'border-color': colors.cycle, 'border-width': 2 } },
    {
      selector: 'node.selected',
      style: {
        'background-color': colors.selected,
        'border-color': colors.selected,
        color: colors.canvasText,
        'font-weight': 'bold',
        'z-index': 20,
      },
    },
    {
      selector: 'node.dependency',
      style: { 'border-color': colors.dependency, 'border-width': 2, 'z-index': 10 },
    },
    {
      selector: 'node.dependent',
      style: { 'border-color': colors.dependent, 'border-width': 2, 'z-index': 10 },
    },
    { selector: 'node.dimmed', style: { opacity: 0.18 } },
    {
      selector: 'edge',
      style: {
        width: 1,
        'line-color': colors.edge,
        'target-arrow-color': colors.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.7,
        'curve-style': 'bezier',
      },
    },
    {
      selector: 'edge[unresolved = 1]',
      style: { 'line-style': 'dashed', 'line-color': colors.unresolved },
    },
    { selector: 'edge[edgeType = "dynamic-import"]', style: { 'line-style': 'dotted' } },
    {
      selector: 'edge.highlighted',
      style: {
        width: 2,
        'line-color': colors.selected,
        'target-arrow-color': colors.selected,
        'z-index': 15,
      },
    },
    { selector: 'edge.dimmed', style: { opacity: 0.08 } },
  ];
}

function layoutOptions(name: LayoutName): LayoutOptions {
  const base = { animate: false, fit: true, padding: 40 };

  if (name === 'dagre') {
    return { ...base, name: 'dagre', rankDir: 'LR', nodeSep: 26, rankSep: 90 } as LayoutOptions;
  }
  if (name === 'breadthfirst') {
    return { ...base, name: 'breadthfirst', directed: true, spacingFactor: 1.1 } as LayoutOptions;
  }
  if (name === 'concentric') {
    return {
      ...base,
      name: 'concentric',
      concentric: (node: cytoscape.NodeSingular) => node.degree(false),
      levelWidth: () => 3,
    } as LayoutOptions;
  }
  return { ...base, name: 'cose', nodeRepulsion: () => 9000, idealEdgeLength: () => 90 } as LayoutOptions;
}

function toElements(payload: GraphPayload): ElementDefinition[] {
  const nodes: ElementDefinition[] = payload.nodes.map((node) => ({
    data: {
      id: node.id,
      label: node.label,
      path: node.path,
      inCycle: node.inCycle ? 1 : 0,
      isEntry: node.isEntryPoint ? 1 : 0,
    },
  }));

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
  const themeRevision = useUiStore((state) => state.themeRevision);

  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [layout, setLayout] = useState<LayoutName>('dagre');
  const [edgeTypes, setEdgeTypes] = useState<Set<EdgeType>>(
    new Set(['import', 're-export', 'dynamic-import', 'require']),
  );
  const [includeUnresolved, setIncludeUnresolved] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [folderPrefix, setFolderPrefix] = useState('');
  const [search, setSearch] = useState('');

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const node of payload?.nodes ?? []) {
      const parts = node.path.split('/');
      parts.pop();
      if (parts.length > 0) set.add(parts[0] as string);
      if (parts.length > 1) set.add(`${parts[0]}/${parts[1]}`);
    }
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
        ...(focusMode && selectedNodeId ? { focusNodeId: selectedNodeId, focusDepth: 2 } : {}),
      });
      setPayload(result);
    } catch {
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [project, edgeTypes, includeUnresolved, folderPrefix, focusMode, selectedNodeId]);

  useEffect(() => {
    void load();
  }, [load, stats]);

  // Build the Cytoscape instance once; element updates reuse it so the viewport is preserved.
  useEffect(() => {
    if (!containerRef.current || cyRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      wheelSensitivity: 0.25,
      minZoom: 0.05,
      maxZoom: 3,
      style: buildStyle(readPalette()),
    });

    cy.on('tap', 'node', (event) => {
      selectNode(event.target.id() as string);
    });

    cy.on('tap', (event) => {
      if (event.target === cy) selectNode(null);
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [selectNode]);

  // A theme swap only needs new colours; the elements and viewport stay as they are.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style(buildStyle(readPalette()));
  }, [themeRevision]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !payload) return;

    cy.elements().remove();
    cy.add(toElements(payload));
    cy.layout(layoutOptions(layout)).run();
  }, [payload, layout]);

  // Highlighting is a class swap rather than a reload, so selection feels instant.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().removeClass('selected dependency dependent highlighted dimmed');
    if (!selectedNodeId) return;

    const node = cy.getElementById(selectedNodeId);
    if (node.empty()) return;

    const dependencies = node.outgoers('node');
    const dependents = node.incomers('node');
    const connectedEdges = node.connectedEdges();

    cy.elements()
      .difference(node.union(dependencies).union(dependents).union(connectedEdges))
      .addClass('dimmed');

    node.addClass('selected');
    dependencies.addClass('dependency');
    dependents.addClass('dependent');
    connectedEdges.addClass('highlighted');
  }, [selectedNodeId, payload]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || search.trim().length === 0) return;

    const needle = search.trim().toLowerCase();
    const matches = cy.nodes().filter((node) => (node.data('path') as string).toLowerCase().includes(needle));
    if (matches.length > 0) {
      cy.animate({ fit: { eles: matches, padding: 80 }, duration: 220 });
    }
  }, [search]);

  if (!project || !stats || stats.totalFiles === 0) {
    return (
      <EmptyState
        title="No graph to show yet"
        description="Scan a project to build and explore its dependency graph."
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find node…"
            className="w-44 rounded border border-edge bg-surface-2 py-1 pl-7 pr-2 text-[11px] text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
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
          className="max-w-40 rounded border border-edge bg-surface-2 px-1.5 py-1 text-[11px] text-ink focus:border-brand focus:outline-none"
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

        <div className="ml-auto flex items-center gap-1">
          {loading && <Loader2 size={13} className="animate-spin text-ink-faint" />}
          <Button size="sm" variant="ghost" onClick={() => cyRef.current?.fit(undefined, 40)}>
            <Maximize2 size={11} />
            Fit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
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

        <div className="pointer-events-none absolute bottom-3 left-3 space-y-1 rounded-md border border-edge bg-surface-1/95 px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">Legend</p>
          {[
            ['Entry point', 'border-risk-low'],
            ['In a cycle', 'border-risk-crit'],
            ['Selected', 'border-brand'],
            ['Depends on selected', 'border-brand'],
            ['Selected depends on', 'border-risk-med'],
          ].map(([label, borderClass]) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className={clsx('h-2 w-2 rounded-sm border bg-transparent', borderClass)} />
              <span className="text-[10px] text-ink-muted">{label}</span>
            </div>
          ))}
          <div className="flex items-center gap-1.5 pt-0.5">
            <span className="h-px w-3 border-t border-dashed border-ink-faint" />
            <span className="text-[10px] text-ink-muted">Unresolved import</span>
          </div>
        </div>
      </div>
    </div>
  );
}
