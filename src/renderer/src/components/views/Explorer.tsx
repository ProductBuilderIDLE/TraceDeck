import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  Box,
  ChevronRight,
  FileCode,
  Folder,
  Hash,
  Search,
  Shapes,
  Type,
} from 'lucide-react';
import type { NodeType, SearchResult, SymbolKind } from '@shared/types';
import { fileNodeId } from '@shared/nodeIds';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { invoke } from '../../lib/ipc';
import { EmptyState, PathLabel } from '../common/ui';

const SYMBOL_ICONS: Record<SymbolKind, typeof Box> = {
  function: Hash,
  class: Box,
  interface: Shapes,
  type: Type,
  enum: Shapes,
  variable: Hash,
  'react-component': Box,
  unknown: Hash,
};

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

function buildTree(paths: readonly string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), isFile: false };

  for (const path of paths) {
    const segments = path.split('/');
    let current = root;

    for (const [index, segment] of segments.entries()) {
      const isLast = index === segments.length - 1;
      const childPath = current.path ? `${current.path}/${segment}` : segment;

      let child = current.children.get(segment);
      if (!child) {
        child = { name: segment, path: childPath, children: new Map(), isFile: isLast };
        current.children.set(segment, child);
      }
      current = child;
    }
  }

  return root;
}

function TreeBranch({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}): JSX.Element {
  const selectedNodeId = useUiStore((state) => state.selectedNodeId);
  const selectNode = useUiStore((state) => state.selectNode);

  const children = useMemo(
    () =>
      [...node.children.values()].sort(
        (a, b) => Number(a.isFile) - Number(b.isFile) || a.name.localeCompare(b.name),
      ),
    [node.children],
  );

  return (
    <ul>
      {children.map((child) => {
        const isOpen = expanded.has(child.path);
        const nodeId = child.isFile ? fileNodeId(child.path) : `folder:${child.path}`;
        const isSelected = selectedNodeId === nodeId;

        return (
          <li key={child.path}>
            <button
              type="button"
              onClick={() => (child.isFile ? selectNode(nodeId) : onToggle(child.path))}
              className={clsx(
                'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px]',
                isSelected ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2',
              )}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
            >
              {child.isFile ? (
                <FileCode size={12} className="shrink-0 text-ink-faint" />
              ) : (
                <>
                  <ChevronRight
                    size={11}
                    className={clsx('shrink-0 transition-transform', isOpen && 'rotate-90')}
                  />
                  <Folder size={12} className="shrink-0 text-ink-faint" />
                </>
              )}
              <span className="truncate">{child.name}</span>
            </button>

            {!child.isFile && isOpen && (
              <TreeBranch node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ResultRow({ result }: { result: SearchResult }): JSX.Element {
  const selectNode = useUiStore((state) => state.selectNode);
  const Icon =
    result.type === 'folder'
      ? Folder
      : result.type === 'file'
        ? FileCode
        : (SYMBOL_ICONS[result.symbolKind ?? 'unknown'] ?? Hash);

  return (
    <button
      type="button"
      onClick={() => selectNode(result.nodeId)}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2"
    >
      <Icon size={12} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-ink">{result.label}</span>
        <PathLabel path={result.path} className="block text-ink-faint" />
      </span>
      {result.type === 'symbol' && (
        <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-muted">
          {result.symbolKind}
        </span>
      )}
    </button>
  );
}

const TYPE_FILTERS: Array<{ id: NodeType; label: string }> = [
  { id: 'file', label: 'Files' },
  { id: 'folder', label: 'Folders' },
  { id: 'symbol', label: 'Symbols' },
];

export function Explorer(): JSX.Element {
  const project = useAppStore((state) => state.currentProject);
  const stats = useAppStore((state) => state.stats);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [types, setTypes] = useState<Set<NodeType>>(new Set(['file', 'folder', 'symbol']));
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['src']));

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // The tree is built from the complete inventory.
  //
  // It previously came from a search for "." capped at 200 results, which quietly dropped
  // every extensionless file (no dot to match) and truncated any project past 200 files —
  // so the tree could look nearly empty even when the scan had found everything.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;

    invoke('inventory:list', { projectId: project.id })
      .then((files) => {
        if (!cancelled) setFilePaths(files.map((file) => file.relativePath));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [project, stats]);

  useEffect(() => {
    if (!project || query.trim().length === 0) {
      setResults([]);
      return;
    }

    let cancelled = false;
    // A short debounce keeps typing responsive on large projects.
    const timer = setTimeout(() => {
      invoke('search:query', {
        projectId: project.id,
        query: query.trim(),
        types: [...types],
        limit: 100,
      })
        .then((found) => {
          if (!cancelled) setResults(found);
        })
        .catch(() => undefined);
    }, 140);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [project, query, types]);

  const tree = useMemo(() => buildTree(filePaths), [filePaths]);

  if (!project || !stats) {
    return (
      <EmptyState
        title="Nothing to explore yet"
        description="Scan a project to browse its files, folders, and exported symbols."
      />
    );
  }

  const searching = query.trim().length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-edge p-3">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files, folders, and symbols…"
            className="w-full rounded-md border border-edge bg-surface-2 py-1.5 pl-8 pr-2.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
            style={{ userSelect: 'text' }}
          />
        </div>

        <div className="flex gap-1.5">
          {TYPE_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() =>
                setTypes((current) => {
                  const next = new Set(current);
                  if (next.has(filter.id)) next.delete(filter.id);
                  else next.add(filter.id);
                  return next.size === 0 ? new Set([filter.id]) : next;
                })
              }
              className={clsx(
                'rounded px-2 py-0.5 text-[11px] transition-colors',
                types.has(filter.id)
                  ? 'bg-brand/15 text-brand'
                  : 'bg-surface-2 text-ink-faint hover:text-ink',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {searching ? (
          results.length === 0 ? (
            <p className="px-2 py-4 text-center text-[12px] text-ink-faint">
              Nothing matches “{query}”.
            </p>
          ) : (
            <div className="space-y-0.5">
              {results.map((result) => (
                <ResultRow key={result.nodeId} result={result} />
              ))}
            </div>
          )
        ) : (
          <>
            <TreeBranch node={tree} depth={0} expanded={expanded} onToggle={toggle} />
            {filePaths.length >= 200 && (
              <p className="px-2 pt-3 text-[11px] text-ink-faint">
                Showing the first 200 files. Use search to find anything not listed.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
