import { promises as fs } from 'node:fs';
import ts from 'typescript';
import { MAX_SOURCE_BYTES, MAX_SOURCE_LINES } from '@shared/constants';
import type { SourceLine, SourceSpan, SourceTokenKind } from '@shared/types';

/**
 * Tokenises source in the main process rather than the renderer.
 *
 * TypeScript is already a dependency here, so its own scanner can do the highlighting: it is
 * accurate for real TypeScript syntax and costs the renderer bundle nothing. Shipping a
 * separate highlighter to the renderer would add weight to reimplement what is already
 * installed.
 */

const KEYWORD_KINDS = new Set<ts.SyntaxKind>();
for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind += 1) {
  KEYWORD_KINDS.add(kind);
}

function classify(kind: ts.SyntaxKind, text: string): SourceTokenKind {
  if (kind === ts.SyntaxKind.SingleLineCommentTrivia) return 'comment';
  if (kind === ts.SyntaxKind.MultiLineCommentTrivia) return 'comment';
  if (KEYWORD_KINDS.has(kind)) return 'keyword';
  if (kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral) return 'number';
  if (
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail ||
    kind === ts.SyntaxKind.RegularExpressionLiteral
  ) {
    return 'string';
  }
  if (kind === ts.SyntaxKind.Identifier) {
    // A capitalised identifier is overwhelmingly a type or component in this codebase's
    // idiom, which is enough to make types read differently from values.
    return /^[A-Z]/.test(text) ? 'type' : 'identifier';
  }
  if (kind >= ts.SyntaxKind.FirstPunctuation && kind <= ts.SyntaxKind.LastPunctuation) {
    return 'punctuation';
  }
  return 'plain';
}

function languageVariant(relativePath: string): ts.LanguageVariant {
  return /\.(tsx|jsx)$/i.test(relativePath) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
}

/** Splits a token that spans several lines, so every span belongs to exactly one line. */
function pushSpan(lines: SourceSpan[][], span: SourceSpan): void {
  const parts = span.text.split('\n');
  if (parts.length === 1) {
    if (span.text.length > 0) lines[lines.length - 1]?.push(span);
    return;
  }

  for (const [index, part] of parts.entries()) {
    if (index > 0) lines.push([]);
    if (part.length > 0) lines[lines.length - 1]?.push({ text: part, kind: span.kind });
  }
}

export interface ReadSourceResult {
  relativePath: string;
  lines: SourceLine[];
  truncated: boolean;
  totalLines: number;
  sizeBytes: number;
}

export async function readSource(
  absolutePath: string,
  relativePath: string,
): Promise<ReadSourceResult> {
  const stats = await fs.stat(absolutePath);

  if (stats.size > MAX_SOURCE_BYTES) {
    return {
      relativePath,
      lines: [],
      truncated: true,
      totalLines: 0,
      sizeBytes: stats.size,
    };
  }

  const text = await fs.readFile(absolutePath, 'utf8');
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    languageVariant(relativePath),
    text,
  );

  const lineSpans: SourceSpan[][] = [[]];

  // Scanning raw text is not JSX-aware the way a full parse is, so a `.tsx` file can have the
  // odd span classified loosely. It never changes the text shown, only its colour.
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    const tokenText = scanner.getTokenText();
    pushSpan(lineSpans, { text: tokenText, kind: classify(kind, tokenText) });
    kind = scanner.scan();
  }

  const totalLines = lineSpans.length;
  const truncated = totalLines > MAX_SOURCE_LINES;
  const kept = truncated ? lineSpans.slice(0, MAX_SOURCE_LINES) : lineSpans;

  return {
    relativePath,
    lines: kept.map((spans, index) => ({ number: index + 1, spans })),
    truncated,
    totalLines,
    sizeBytes: stats.size,
  };
}
