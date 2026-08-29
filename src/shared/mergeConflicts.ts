export interface MergeConflict {
  /** 1-based line of the `<<<<<<<` marker. */
  startLine: number;
  /** 1-based line of the `>>>>>>>` marker, or null when the group is incomplete. */
  endLine: number | null;
  complete: boolean;
  label: string;
}

const START = /^<{7}(?: |$)/;
const SEPARATOR = /^={7}$/;
const END = /^>{7}(?: |$)/;

/**
 * Finds Git conflict markers in a text file.
 *
 * Matching is anchored to the start of a line and requires exactly seven characters, so prose
 * that merely discusses conflicts — or a row of equals signs used as a heading underline —
 * is not reported. An unterminated group is still reported, because a file left mid-merge is
 * precisely the case worth surfacing.
 */
export function findMergeConflicts(text: string): MergeConflict[] {
  const lines = text.split(/\r?\n/);
  const conflicts: MergeConflict[] = [];

  let openLine: number | null = null;
  let openLabel = '';
  let sawSeparator = false;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (START.test(line)) {
      // A second start before an end means the first group is unterminated.
      if (openLine !== null) {
        conflicts.push({ startLine: openLine, endLine: null, complete: false, label: openLabel });
      }
      openLine = lineNumber;
      openLabel = line.slice(7).trim();
      sawSeparator = false;
      continue;
    }

    if (openLine === null) continue;

    if (SEPARATOR.test(line)) {
      sawSeparator = true;
      continue;
    }

    if (END.test(line)) {
      conflicts.push({
        startLine: openLine,
        endLine: lineNumber,
        // Without a separator the markers are not a real three-way conflict block.
        complete: sawSeparator,
        label: openLabel,
      });
      openLine = null;
      openLabel = '';
      sawSeparator = false;
    }
  }

  if (openLine !== null) {
    conflicts.push({ startLine: openLine, endLine: null, complete: false, label: openLabel });
  }

  return conflicts;
}
