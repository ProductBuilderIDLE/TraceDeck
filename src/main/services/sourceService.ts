import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import ts from 'typescript';
import { MAX_SOURCE_BYTES, MAX_SOURCE_LINES } from '@shared/constants';
import type {
  SourceDocument,

  SourceSpan,
  SourceTokenKind,
  SourceUnavailableDocument,
  SourceUnavailableReason,
} from '@shared/types';
import { readEditorConfig } from './formatService';
import { decodeText, detectEncoding, isDecodableText } from './fileClassificationService';

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

function unavailable(
  relativePath: string,
  reason: SourceUnavailableReason,
  message: string,
  sizeBytes: number,
): SourceUnavailableDocument {
  return { kind: 'unavailable', relativePath, reason, message, sizeBytes };
}

/**
 * Reads one project file for the viewer.
 *
 * Any file in the inventory can be requested, not just graph sources, so this must answer for
 * binaries, oversized files, symlinks, and undecodable content too. Each of those returns an
 * explained `unavailable` result rather than an empty document, so the UI can say what is
 * actually going on instead of appearing broken.
 */
export async function readSource(
  absolutePath: string,
  relativePath: string,
  rootPath?: string,
): Promise<SourceDocument> {
  // lstat, not stat: a symlink must be reported as itself rather than silently followed.
  const stats = await fs.lstat(absolutePath);

  if (stats.isSymbolicLink()) {
    return unavailable(
      relativePath,
      'symlink',
      'This entry is a symbolic link. TraceDeck never follows links, so its target is not read.',
      0,
    );
  }

  if (!stats.isFile()) {
    return unavailable(relativePath, 'unreadable', 'This entry is not a regular file.', 0);
  }

  if (stats.size > MAX_SOURCE_BYTES) {
    return unavailable(
      relativePath,
      'too-large',
      `This file is ${(stats.size / 1024 / 1024).toFixed(1)} MB, larger than the ${Math.round(
        MAX_SOURCE_BYTES / 1024 / 1024,
      )} MB the viewer will load. Open it in your editor instead.`,
      stats.size,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absolutePath);
  } catch {
    return unavailable(
      relativePath,
      'unreadable',
      'This file could not be read from disk. It may have been moved, or permission was denied.',
      stats.size,
    );
  }

  // Detection is shared with the inventory classifier so the viewer and the scan never
  // disagree about whether a given file is text.
  const encoding = detectEncoding(bytes);
  if (!isDecodableText(bytes, encoding)) {
    return unavailable(
      relativePath,
      'binary',
      'This file is binary, so there is no text to display.',
      stats.size,
    );
  }

  let text: string;
  try {
    text = decodeText(bytes, encoding);
  } catch {
    return unavailable(
      relativePath,
      'unsupported-encoding',
      `This file uses the ${encoding} encoding, which the viewer cannot decode.`,
      stats.size,
    );
  }

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
  const editorConfig = rootPath ? await readEditorConfig(rootPath, relativePath) : undefined;

  return {
    kind: 'text',
    relativePath,
    lines: kept.map((spans, index) => ({ number: index + 1, spans })),
    truncated,
    totalLines,
    sizeBytes: stats.size,
    encoding,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    text,
    // A truncated view holds only part of the file, so saving it would destroy the rest.
    editable: !truncated,
    ...(editorConfig ? { editorConfig } : {}),
  };
}
