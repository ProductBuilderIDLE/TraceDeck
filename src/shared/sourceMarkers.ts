import { findMergeConflicts } from './mergeConflicts';
import { liveJsonSyntaxIssue, isStrictJsonPath } from './jsonSyntax';
import { fileNodeId } from './nodeIds';
import type { Finding } from './types';

export type LineMarkKind = 'conflict' | 'broken';

export interface LineMark {
  kind: LineMarkKind;
  titles: string[];
}

function posixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function findingPath(finding: Finding): string | null {
  const details = finding.details;
  if (!details || typeof details !== 'object' || !('kind' in details)) return null;

  switch (details.kind) {
    case 'merge-conflict':
    case 'syntax-error':
    case 'unresolved-import':
    case 'unused-export':
    case 'todo-comment':
    case 'complexity-hotspot':
      return details.filePath;
    case 'type-error':
      return details.filePath;
    case 'architecture-violation':
      return details.sourcePath;
    default:
      return null;
  }
}

function findingLines(finding: Finding): number[] {
  const details = finding.details;
  if (!details || typeof details !== 'object' || !('kind' in details)) return [];

  if (details.kind === 'merge-conflict') {
    const start = details.startLine;
    const end = details.endLine ?? details.startLine;
    if (start < 1) return [];
    const lines: number[] = [];
    for (let line = start; line <= end; line += 1) lines.push(line);
    return lines;
  }

  if (details.kind === 'syntax-error') return details.line > 0 ? [details.line] : [];
  if (details.kind === 'type-error') {
    return details.line !== null && details.line > 0 ? [details.line] : [];
  }
  if (details.kind === 'unresolved-import') {
    return details.line !== null && details.line > 0 ? [details.line] : [];
  }
  if (details.kind === 'todo-comment' || details.kind === 'complexity-hotspot') {
    return details.line > 0 ? [details.line] : [];
  }
  if (details.kind === 'duplicate-code') {
    return details.startLines.filter((line) => line > 0);
  }
  return [];
}

function markKind(finding: Finding): LineMarkKind | null {
  if (finding.findingType === 'merge-conflict') return 'conflict';
  if (
    finding.findingType === 'syntax-error' ||
    finding.findingType === 'type-error' ||
    finding.findingType === 'unresolved-import' ||
    finding.findingType === 'todo-comment' ||
    finding.findingType === 'complexity-hotspot' ||
    finding.findingType === 'duplicate-code'
  ) {
    return 'broken';
  }
  return null;
}

function appliesToFile(finding: Finding, relativePath: string): boolean {
  const path = posixPath(relativePath);
  const fromDetails = findingPath(finding);
  if (fromDetails && posixPath(fromDetails) === path) return true;
  return finding.relatedNodeIds.includes(fileNodeId(path));
}

/**
 * Maps scan findings onto source lines for the open file.
 *
 * Orange (`conflict`) is a merge-conflict marker. Red (`broken`) is a syntax error, type
 * error, or unresolved import. A conflict on the same line wins, because that is the more
 * specific reason the line cannot be trusted.
 */
export function lineMarksForFile(
  findings: readonly Finding[],
  relativePath: string,
): Map<number, LineMark> {
  const marks = new Map<number, LineMark>();

  for (const finding of findings) {
    if (finding.dismissedAt) continue;
    const kind = markKind(finding);
    if (!kind) continue;
    if (!appliesToFile(finding, relativePath)) continue;

    for (const line of findingLines(finding)) {
      const existing = marks.get(line);
      if (!existing) {
        marks.set(line, { kind, titles: [finding.title] });
        continue;
      }
      if (!existing.titles.includes(finding.title)) existing.titles.push(finding.title);
      if (kind === 'conflict') existing.kind = 'conflict';
    }
  }

  return marks;
}

function conflictTitle(complete: boolean, startLine: number, label: string): string {
  if (!complete) return `Unterminated merge conflict on line ${startLine}`;
  return label ? `Unresolved merge conflict (${label})` : 'Unresolved merge conflict';
}

/**
 * Marks conflict spans in the live buffer. Used so the gutter can update while typing,
 * without waiting for a scan of the saved file.
 */
export function liveConflictMarks(text: string): Map<number, LineMark> {
  const marks = new Map<number, LineMark>();

  for (const conflict of findMergeConflicts(text)) {
    const end = conflict.endLine ?? conflict.startLine;
    const title = conflictTitle(conflict.complete, conflict.startLine, conflict.label);
    for (let line = conflict.startLine; line <= end; line += 1) {
      const existing = marks.get(line);
      if (!existing) {
        marks.set(line, { kind: 'conflict', titles: [title] });
        continue;
      }
      if (!existing.titles.includes(title)) existing.titles.push(title);
    }
  }

  return marks;
}

/**
 * Replaces scan-based conflict marks with marks from the live text, and keeps broken-line
 * marks from the last scan. The open buffer is the source of truth for conflicts: a marker
 * the user just typed should show immediately, and one they just deleted should disappear.
 */
export function withLiveConflicts(
  scanMarks: Map<number, LineMark>,
  text: string,
  relativePath?: string,
): Map<number, LineMark> {
  const merged = new Map<number, LineMark>();

  for (const [line, mark] of scanMarks) {
    if (mark.kind === 'conflict') continue;
    if (relativePath && isStrictJsonPath(relativePath) && mark.kind === 'broken') continue;
    merged.set(line, { kind: mark.kind, titles: [...mark.titles] });
  }

  for (const [line, mark] of liveConflictMarks(text)) {
    const existing = merged.get(line);
    if (!existing) {
      merged.set(line, { kind: 'conflict', titles: [...mark.titles] });
      continue;
    }
    for (const title of mark.titles) {
      if (!existing.titles.includes(title)) existing.titles.push(title);
    }
    existing.kind = 'conflict';
  }

  if (relativePath) {
    const jsonIssue = liveJsonSyntaxIssue(relativePath, text);
    if (jsonIssue) {
      const title = jsonIssue.message;
      const existing = merged.get(jsonIssue.line);
      if (!existing) {
        merged.set(jsonIssue.line, { kind: 'broken', titles: [title] });
      } else {
        if (!existing.titles.includes(title)) existing.titles.push(title);
        if (existing.kind !== 'conflict') existing.kind = 'broken';
      }
    }
  }

  return merged;
}
