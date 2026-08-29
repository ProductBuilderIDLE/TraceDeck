/**
 * Buffer-local completions. These only look at text already in the open file — the same
 * trick 1990s editors used. They cannot invent a line that is not already written somewhere
 * in this buffer; that would be a language model.
 */

export function lineCompletion(
  lines: readonly string[],
  lineIndex: number,
  column: number,
): string | null {
  const before = (lines[lineIndex] ?? '').slice(0, Math.max(0, column));
  if (before.trim().length < 2) return null;

  let best: string | null = null;
  for (const [index, other] of lines.entries()) {
    if (index === lineIndex) continue;
    if (!other.startsWith(before)) continue;
    const rest = other.slice(before.length);
    if (rest.length === 0) continue;
    if (best === null || rest.length > best.length) best = rest;
  }
  return best;
}
