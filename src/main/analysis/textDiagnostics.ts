import ts from 'typescript';
import { isJsonPath } from '@shared/jsonSyntax';

export { findMergeConflicts, type MergeConflict } from '@shared/mergeConflicts';
export { isJsonPath };

export interface TextDiagnostic {
  line: number;
  column: number;
  /** TypeScript diagnostic code for JSON syntax, or 0 for a structural finding. */
  code: number;
  message: string;
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
