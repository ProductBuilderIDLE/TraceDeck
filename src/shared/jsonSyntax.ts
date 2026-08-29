export function isJsonPath(relativePath: string): boolean {
  return /\.(json|jsonc|json5)$/i.test(relativePath.replaceAll('\\', '/'));
}

export function isStrictJsonPath(relativePath: string): boolean {
  return /\.json$/i.test(relativePath.replaceAll('\\', '/'));
}

function positionAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * Strict JSON syntax check for the live editor overlay.
 *
 * `.jsonc` / `.json5` are allowed to be looser, so they are not run through `JSON.parse`.
 * The scan still uses the TypeScript JSON parser for those extensions.
 */
export function liveJsonSyntaxIssue(
  relativePath: string,
  text: string,
): { line: number; column: number; message: string } | null {
  if (!isStrictJsonPath(relativePath) || text.trim().length === 0) return null;

  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON.';
    const offset = Number(/at position (\d+)/.exec(message)?.[1] ?? NaN);
    const { line, column } = Number.isFinite(offset)
      ? positionAt(text, offset)
      : { line: 1, column: 1 };
    return { line, column, message };
  }
}
