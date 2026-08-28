import { extname } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ParsedFile } from '../parser';
import {
  extractCssReferences,
  extractGoReferences,
  extractHtmlReferences,
  extractPythonReferences,
  extractRustReferences,
} from './extractors';
import { getParser, grammarFailure, type TreeSitterLanguageId } from './runtime';

const LANGUAGE_BY_EXTENSION: Record<string, TreeSitterLanguageId> = {
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

/** Extensions parsed by tree-sitter rather than the TypeScript compiler. */
export const TREE_SITTER_EXTENSIONS: readonly string[] = Object.keys(LANGUAGE_BY_EXTENSION);

export function treeSitterLanguageFor(relativePath: string): TreeSitterLanguageId | null {
  return LANGUAGE_BY_EXTENSION[extname(relativePath).toLowerCase()] ?? null;
}

function referencesFor(language: TreeSitterLanguageId, root: Node, relativePath: string) {
  switch (language) {
    case 'html':
      return extractHtmlReferences(root);
    case 'css':
      return extractCssReferences(root);
    case 'python':
      return extractPythonReferences(root);
    case 'go':
      return extractGoReferences(root);
    case 'rust':
      return extractRustReferences(root, relativePath);
  }
}

/**
 * Parses a non-JavaScript source file into the same shape the TypeScript path produces, so
 * the graph builder does not need to know which parser handled a file.
 *
 * Every reference becomes a plain `import` edge. These languages have no export surface to
 * model, so symbols stay empty and unused-export analysis is unaffected by them.
 */
export async function parseWithTreeSitter(
  relativePath: string,
  text: string,
): Promise<ParsedFile | null> {
  const language = treeSitterLanguageFor(relativePath);
  if (!language) return null;

  const parser = await getParser(language);
  if (!parser) {
    const reason = grammarFailure(language);
    return {
      imports: [],
      symbols: [],
      parseErrors: [],
      limitations: [
        `${relativePath}: the ${language} grammar could not be loaded${
          reason ? ` (${reason})` : ''
        }, so its references were not analysed.`,
      ],
    };
  }

  const tree = parser.parse(text);
  if (!tree) {
    return {
      imports: [],
      symbols: [],
      parseErrors: [`${relativePath} could not be parsed.`],
      limitations: [],
    };
  }

  try {
    const references = referencesFor(language, tree.rootNode, relativePath);

    const limitations: string[] = [];
    // Malformed markup still yields a usable tree, so references are kept and the
    // uncertainty is reported rather than the file being silently dropped.
    if (tree.rootNode.hasError) {
      limitations.push(
        `${relativePath}: the parser recovered from a syntax error, so some references may be missing.`,
      );
    }

    return {
      imports: references.map((reference) => ({
        specifier: reference.specifier,
        line: reference.line,
        kind: 'import' as const,
        isTypeOnly: false,
        importedNames: [],
        isStarExport: false,
        isDynamicExpression: false,
      })),
      symbols: [],
      parseErrors: [],
      limitations,
    };
  } finally {
    tree.delete();
  }
}
