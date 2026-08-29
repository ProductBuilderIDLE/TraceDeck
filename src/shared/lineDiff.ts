/**
 * Line-oriented session diff. Used by the code viewer to list what changed since the file
 * was opened, without adding a git dependency or a new IPC channel.
 *
 * Myers O(ND) is used because a typical in-app edit has a small edit distance even when the
 * file is large; an LCS table would be quadratic in the line count.
 */

export interface DiffHunk {
  /** 1-based line number in the original snapshot where this hunk starts. */
  oldStart: number;
  /** 1-based line number in the current text where this hunk starts. */
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

type DiffOp = { kind: 'eq' | 'del' | 'ins'; line: string };

function at(vector: Int32Array, index: number): number {
  return vector[index] ?? 0;
}

function shortestEdit(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return [];

  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  v[offset + 1] = 0;
  const traces: Int32Array[] = [];

  let doneAt = -1;
  outer: for (let d = 0; d <= max; d += 1) {
    traces.push(Int32Array.from(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && at(v, offset + k - 1) < at(v, offset + k + 1))) {
        x = at(v, offset + k + 1);
      } else {
        x = at(v, offset + k - 1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        doneAt = d;
        traces.push(Int32Array.from(v));
        break outer;
      }
    }
  }

  if (doneAt < 0) return [];

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = doneAt; d > 0; d -= 1) {
    const prev = traces[d];
    if (!prev) break;
    const k = x - y;
    const wentDown =
      k === -d || (k !== d && at(prev, offset + k - 1) < at(prev, offset + k + 1));
    const prevK = wentDown ? k + 1 : k - 1;
    const prevX = at(prev, offset + prevK);
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: 'eq', line: oldLines[x] ?? '' });
    }

    if (wentDown) {
      y -= 1;
      ops.push({ kind: 'ins', line: newLines[y] ?? '' });
    } else {
      x -= 1;
      ops.push({ kind: 'del', line: oldLines[x] ?? '' });
    }
  }

  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: 'eq', line: oldLines[x] ?? '' });
  }
  while (x > 0) {
    x -= 1;
    ops.push({ kind: 'del', line: oldLines[x] ?? '' });
  }
  while (y > 0) {
    y -= 1;
    ops.push({ kind: 'ins', line: newLines[y] ?? '' });
  }

  ops.reverse();
  return ops;
}

function groupHunks(ops: readonly DiffOp[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: DiffHunk | null = null;

  const flush = (): void => {
    if (current && (current.oldLines.length > 0 || current.newLines.length > 0)) {
      hunks.push(current);
    }
    current = null;
  };

  for (const op of ops) {
    if (op.kind === 'eq') {
      flush();
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (!current) {
      current = { oldStart: oldLine, newStart: newLine, oldLines: [], newLines: [] };
    }
    if (op.kind === 'del') {
      current.oldLines.push(op.line);
      oldLine += 1;
    } else {
      current.newLines.push(op.line);
      newLine += 1;
    }
  }
  flush();
  return hunks;
}

export function diffHunks(oldText: string, newText: string): DiffHunk[] {
  if (oldText === newText) return [];
  return groupHunks(shortestEdit(splitLines(oldText), splitLines(newText)));
}

export function hunkSummary(hunk: DiffHunk): string {
  const removed = hunk.oldLines.length;
  const added = hunk.newLines.length;
  if (removed > 0 && added > 0) {
    return `Line ${hunk.oldStart}: −${removed} / +${added}`;
  }
  if (removed > 0) {
    return `Line ${hunk.oldStart}: −${removed}`;
  }
  return `Line ${hunk.newStart}: +${added}`;
}
