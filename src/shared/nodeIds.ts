import type { NodeType } from './types';

/**
 * Graph nodes are addressed by a stable string key rather than a database row id, so that
 * incremental rescans can rebuild rows without invalidating every edge that points at them.
 *
 *   file    -> file:src/app.ts
 *   symbol  -> symbol:src/app.ts#renderApp
 *   folder  -> folder:src/components
 */

export function fileNodeId(relativePath: string): string {
  return `file:${relativePath}`;
}

export function symbolNodeId(relativePath: string, symbolName: string): string {
  return `symbol:${relativePath}#${symbolName}`;
}

export function folderNodeId(relativePath: string): string {
  return `folder:${relativePath}`;
}

export interface ParsedNodeId {
  type: NodeType;
  path: string;
  symbolName?: string;
}

export function parseNodeId(nodeId: string): ParsedNodeId | null {
  const separator = nodeId.indexOf(':');
  if (separator === -1) return null;

  const prefix = nodeId.slice(0, separator);
  const rest = nodeId.slice(separator + 1);
  if (rest.length === 0) return null;

  if (prefix === 'file') return { type: 'file', path: rest };
  if (prefix === 'folder') return { type: 'folder', path: rest };

  if (prefix === 'symbol') {
    // Symbol names cannot contain '#', so the last one is always the separator.
    const hash = rest.lastIndexOf('#');
    if (hash <= 0 || hash === rest.length - 1) return null;
    return { type: 'symbol', path: rest.slice(0, hash), symbolName: rest.slice(hash + 1) };
  }

  return null;
}

/** The file a node belongs to: itself for files, its owner for symbols, null for folders. */
export function owningFilePath(nodeId: string): string | null {
  const parsed = parseNodeId(nodeId);
  if (!parsed) return null;
  if (parsed.type === 'folder') return null;
  return parsed.path;
}
