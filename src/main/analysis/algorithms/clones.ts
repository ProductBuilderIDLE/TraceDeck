export interface CloneFileInput {
  relativePath: string;
  text: string;
}

export interface CloneGroup {
  filePaths: string[];
  startLines: number[];
  lineCount: number;
  hash: string;
}

const MIN_LINES = 6;

function normalizeLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (/^[{}();,]+$/.test(trimmed)) return null;
  return trimmed.replace(/\s+/g, ' ');
}

/**
 * Finds duplicated blocks of at least six normalised lines across the given files.
 *
 * Identity is a hash of the normalised text, so whitespace and blank lines do not create
 * extra groups. Each file contributes at most one start line per group.
 */
export function findDuplicateBlocks(files: readonly CloneFileInput[]): CloneGroup[] {
  const buckets = new Map<string, Array<{ path: string; startLine: number }>>();

  for (const file of files) {
    const normalised: Array<{ line: number; text: string }> = [];
    const raw = file.text.split(/\r?\n/);
    for (let index = 0; index < raw.length; index += 1) {
      const text = normalizeLine(raw[index] ?? '');
      if (text === null) continue;
      normalised.push({ line: index + 1, text });
    }

    for (let start = 0; start + MIN_LINES <= normalised.length; start += 1) {
      const window = normalised.slice(start, start + MIN_LINES);
      const hash = window.map((entry) => entry.text).join('\n');
      const first = window[0];
      if (!first) continue;
      const bucket = buckets.get(hash) ?? [];
      if (!bucket.some((entry) => entry.path === file.relativePath && entry.startLine === first.line)) {
        bucket.push({ path: file.relativePath, startLine: first.line });
      }
      buckets.set(hash, bucket);
    }
  }

  const groups: CloneGroup[] = [];
  for (const [hash, occurrences] of buckets) {
    const uniqueFiles = [...new Set(occurrences.map((entry) => entry.path))];
    if (uniqueFiles.length < 2 && occurrences.length < 2) continue;
    if (occurrences.length < 2) continue;
    groups.push({
      filePaths: occurrences.map((entry) => entry.path),
      startLines: occurrences.map((entry) => entry.startLine),
      lineCount: MIN_LINES,
      hash,
    });
  }

  groups.sort((left, right) => right.filePaths.length - left.filePaths.length || left.hash.localeCompare(right.hash));
  return groups.slice(0, 200);
}
