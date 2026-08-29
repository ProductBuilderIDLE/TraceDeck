import { extname } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ParsedFile } from '../parser';
import { blankOutside, markupTagRegions } from '../parser';
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
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

/** Extensions parsed by tree-sitter rather than the TypeScript compiler. */
export const TREE_SITTER_EXTENSIONS: readonly string[] = Object.keys(LANGUAGE_BY_EXTENSION);

export function treeSitterLanguageFor(relativePath: string): TreeSitterLanguageId | null {
  return LANGUAGE_BY_EXTENSION[extname(relativePath).toLowerCase()] ?? null;
}

function syntaxIssuesFrom(root: Node): ParsedFile['syntaxIssues'] {
  const issues: ParsedFile['syntaxIssues'] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'ERROR') {
      issues.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        message: 'Syntax error',
      });
    }
    for (let index = 0; index < node.namedChildCount; index += 1) {
      const child = node.namedChild(index);
      if (child) stack.push(child);
    }
  }
  return issues;
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
      calls: [],
      parseErrors: [],
      syntaxIssues: [],
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
      calls: [],
      parseErrors: [`${relativePath} could not be parsed.`],
      syntaxIssues: [
        { line: 1, column: 1, message: `${relativePath} could not be parsed.` },
      ],
      limitations: [],
    };
  }

  try {
    const references = referencesFor(language, tree.rootNode, relativePath);
    const syntaxIssues = syntaxIssuesFrom(tree.rootNode);

    const limitations: string[] = [];
    if (tree.rootNode.hasError && syntaxIssues.length === 0) {
      syntaxIssues.push({ line: 1, column: 1, message: 'Syntax error' });
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
      calls: [],
      parseErrors: [],
      syntaxIssues,
      limitations,
    };
  } finally {
    tree.delete();
  }
}

export async function parseTreeSitterLanguage(
  language: TreeSitterLanguageId,
  relativePath: string,
  text: string,
): Promise<ParsedFile> {
  const parser = await getParser(language);
  if (!parser) {
    const reason = grammarFailure(language);
    return {
      imports: [],
      symbols: [],
      calls: [],
      parseErrors: [],
      syntaxIssues: [],
      limitations: [
        `${relativePath}: the ${language} grammar could not be loaded${
          reason ? ` (${reason})` : ''
        }.`,
      ],
    };
  }

  const tree = parser.parse(text);
  if (!tree) {
    return {
      imports: [],
      symbols: [],
      calls: [],
      parseErrors: [],
      syntaxIssues: [],
      limitations: [`${relativePath}: ${language} region could not be parsed.`],
    };
  }

  try {
    const references = referencesFor(language, tree.rootNode, relativePath);
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
      calls: [],
      parseErrors: [],
      syntaxIssues: syntaxIssuesFrom(tree.rootNode),
      limitations: [],
    };
  } finally {
    tree.delete();
  }
}

/**
 * Analyses Vue/Svelte/Astro template and style regions with the HTML and CSS grammars.
 * Line numbers stay aligned with the original file because non-region text is blanked.
 */
export async function parseContainerMarkup(
  relativePath: string,
  text: string,
): Promise<ParsedFile> {
  const template = blankOutside(text, markupTagRegions(text, 'template'));
  const style = blankOutside(text, markupTagRegions(text, 'style'));
  const html = await parseTreeSitterLanguage('html', relativePath, template);
  const css = await parseTreeSitterLanguage('css', relativePath, style);
  return {
    imports: [...html.imports, ...css.imports],
    symbols: [],
    calls: [],
    parseErrors: [...html.parseErrors, ...css.parseErrors],
    syntaxIssues: [...html.syntaxIssues, ...css.syntaxIssues],
    limitations: [...html.limitations, ...css.limitations],
  };
}
