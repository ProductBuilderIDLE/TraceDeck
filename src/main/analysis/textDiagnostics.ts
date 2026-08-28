import ts from 'typescript';

export interface TextDiagnostic {
  line: number;
  column: number;
  /** TypeScript diagnostic code for JSON syntax, or 0 for a structural finding. */
  code: number;
  message: string;
}

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

/**
 * Parses JSON through the TypeScript API rather than `JSON.parse`.
 *
 * `JSON.parse` reports only the first failure, and as a character offset that would have to be
 * converted back to a line and column. The compiler already returns positioned diagnostics,
 * and it is a dependency this project has anyway.
 */
export function diagnoseJson(relativePath: string, text: string): TextDiagnostic[] {
  const source = ts.parseJsonText(relativePath, text);
  const diagnostics = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;

  if (!diagnostics || diagnostics.length === 0) {
    return /\.json$/i.test(relativePath) ? diagnoseStrictJson(text) : [];
  }

  return diagnostics.map((diagnostic) => {
    const position =
      diagnostic.start === undefined
        ? { line: 0, character: 0 }
        : source.getLineAndCharacterOfPosition(diagnostic.start);

    return {
      line: position.line + 1,
      column: position.character + 1,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    };
  });
}

/** Converts a character offset into a 1-based line and column. */
function positionAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * Validates strict JSON on top of the compiler's structural check.
 *
 * The TypeScript parser is intentionally JSONC-tolerant and accepts trailing commas, so it
 * alone would pass a file that a real `JSON.parse` consumer would reject at runtime. This is
 * applied only to `.json`, because `.jsonc` and `.json5` allow that syntax by design.
 */
function diagnoseStrictJson(text: string): TextDiagnostic[] {
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON.';
    const offset = Number(/at position (\d+)/.exec(message)?.[1] ?? NaN);
    const { line, column } = Number.isFinite(offset)
      ? positionAt(text, offset)
      : { line: 1, column: 1 };

    return [{ line, column, code: 0, message }];
  }
}

/** True when the extension is JSON-like enough to be parsed as JSON. */
export function isJsonPath(relativePath: string): boolean {
  return /\.(json|jsonc|json5)$/i.test(relativePath);
}
