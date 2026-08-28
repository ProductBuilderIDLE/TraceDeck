import ts from 'typescript';
import type { SymbolKind, SymbolMetadata } from '@shared/types';

export type ImportKind = 'import' | 'dynamic-import' | 'require' | 're-export';

export interface ParsedImport {
  specifier: string;
  line: number;
  kind: ImportKind;
  isTypeOnly: boolean;
  /** Named bindings pulled from the module; empty for namespace or side-effect imports. */
  importedNames: string[];
  /** True for `export * from '...'`, which makes downstream usage impossible to pin down. */
  isStarExport: boolean;
  /**
   * True when the specifier was not a plain string literal, e.g. `import(buildPath(name))`.
   * These are reported as unresolvable rather than guessed at.
   */
  isDynamicExpression: boolean;
}

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  isExported: boolean;
  isDefaultExport: boolean;
  startLine: number;
  endLine: number;
  metadata: SymbolMetadata;
}

export interface ParsedCall {
  callee: string;
  line: number;
}

export interface SyntaxIssue {
  line: number;
  column: number;
  message: string;
}

export interface ParsedFile {
  imports: ParsedImport[];
  symbols: ParsedSymbol[];
  calls: ParsedCall[];
  parseErrors: string[];
  /** Line-addressable syntax problems; the scanner turns these into findings. */
  syntaxIssues: SyntaxIssue[];
  /** Honest boundaries that did not prevent parsing, such as unanalysed template regions. */
  limitations: string[];
}

interface SourceRegion {
  start: number;
  end: number;
}

interface PreparedSource {
  contents: string;
  limitations: string[];
}

interface ScriptExtraction {
  regions: SourceRegion[];
  limitations: string[];
}

interface ScriptAttribute {
  present: boolean;
  value: string | null;
}

const SOURCE_CONTAINER_EXTENSIONS = ['.vue', '.svelte', '.astro'] as const;

function sourceContainerExtension(
  fileName: string,
): (typeof SOURCE_CONTAINER_EXTENSIONS)[number] | null {
  const lowerName = fileName.toLowerCase();
  return SOURCE_CONTAINER_EXTENSIONS.find((candidate) => lowerName.endsWith(candidate)) ?? null;
}

/** Limitations are derived from the file type so incremental scans can reproduce them exactly. */
export function sourceContainerLimitations(fileName: string): string[] {
  const extension = sourceContainerExtension(fileName);
  if (!extension) return [];
  return [
    `${extension} source container: script regions analysed by the TypeScript compiler; ` +
      'template and style regions analysed via tree-sitter.',
  ];
}

function scriptAttribute(attributes: string, name: string): ScriptAttribute {
  const match = new RegExp(
    `(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+)))?`,
    'i',
  ).exec(attributes);
  return {
    present: match !== null,
    value: match ? (match[1] ?? match[2] ?? match[3] ?? null) : null,
  };
}

function markupCommentRegions(contents: string): SourceRegion[] {
  const regions: SourceRegion[] = [];
  for (const match of contents.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
    if (match.index === undefined) continue;
    regions.push({ start: match.index, end: match.index + match[0].length });
  }
  return regions;
}

function scriptRegions(contents: string): ScriptExtraction {
  const regions: SourceRegion[] = [];
  const limitations: string[] = [];
  const comments = markupCommentRegions(contents);
  const blocks = /<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi;

  for (const match of contents.matchAll(blocks)) {
    if (match.index === undefined) continue;
    const matchIndex = match.index;
    if (comments.some((comment) => matchIndex >= comment.start && matchIndex < comment.end)) {
      continue;
    }

    const attributes = match[1] ?? '';
    const source = scriptAttribute(attributes, 'src');
    if (source.present) {
      limitations.push(
        `External script block "${source.value ?? '(unspecified)'}" was not analysed; ` +
          'source-container script references are not read automatically.',
      );
      continue;
    }

    const language = scriptAttribute(attributes, 'lang');
    if (
      language.present &&
      !['js', 'javascript', 'ts', 'typescript'].includes((language.value ?? '').toLowerCase())
    ) {
      limitations.push(
        `Script block with unsupported language "${language.value ?? '(unspecified)'}" was not analysed.`,
      );
      continue;
    }

    const type = scriptAttribute(attributes, 'type');
    if (
      type.present &&
      ![
        'module',
        'text/javascript',
        'application/javascript',
        'text/typescript',
        'application/typescript',
      ].includes((type.value ?? '').toLowerCase())
    ) {
      limitations.push(
        `Script block with unsupported type "${type.value ?? '(unspecified)'}" was not analysed.`,
      );
      continue;
    }

    const openingEnd = match[0].indexOf('>');
    const closingStart = match[0].toLowerCase().lastIndexOf('</script');
    if (openingEnd < 0 || closingStart < openingEnd) continue;
    regions.push({
      start: matchIndex + openingEnd + 1,
      end: matchIndex + closingStart,
    });
  }

  return { regions, limitations };
}

export function markupTagRegions(contents: string, tag: 'template' | 'style'): SourceRegion[] {
  const regions: SourceRegion[] = [];
  const comments = markupCommentRegions(contents);
  const blocks = new RegExp(`<${tag}\\b([^>]*)>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
  for (const match of contents.matchAll(blocks)) {
    if (match.index === undefined) continue;
    if (comments.some((comment) => match.index >= comment.start && match.index < comment.end)) {
      continue;
    }
    const openingEnd = match[0].indexOf('>');
    const closingStart = match[0].toLowerCase().lastIndexOf(`</${tag}`);
    if (openingEnd < 0 || closingStart < openingEnd) continue;
    regions.push({
      start: match.index + openingEnd + 1,
      end: match.index + closingStart,
    });
  }
  return regions;
}

/** Keeps tagged regions and blanks everything else, preserving line numbers. */
export function blankOutside(contents: string, regions: readonly SourceRegion[]): string {
  if (regions.length === 0) return contents.replace(/[^\n]/g, ' ');
  const ordered = [...regions].sort((left, right) => left.start - right.start);
  let output = '';
  let cursor = 0;
  for (const region of ordered) {
    output += contents.slice(cursor, region.start).replace(/[^\n]/g, ' ');
    output += contents.slice(region.start, region.end);
    cursor = region.end;
  }
  output += contents.slice(cursor).replace(/[^\n]/g, ' ');
  return output;
}

/**
 * Inspects source-container boundaries without invoking the TypeScript parser. Scanner uses this
 * on every already-read file so caveats remain available when an unchanged graph row is reused.
 */
export function inspectSourceContainerLimitations(fileName: string, contents: string): string[] {
  if (!sourceContainerExtension(fileName)) return [];
  return [...sourceContainerLimitations(fileName), ...scriptRegions(contents).limitations];
}

function astroFrontmatterRegion(contents: string): SourceRegion | null {
  const match = /^\uFEFF?---[^\S\r\n]*(?:\r?\n)[\s\S]*?(?:\r?\n)---(?=\r?\n|$)/.exec(contents);
  if (!match) return null;

  const openingEnd = match[0].indexOf('\n');
  const closingStart = match[0].lastIndexOf('\n---');
  if (openingEnd < 0 || closingStart < openingEnd) return null;
  return { start: openingEnd + 1, end: closingStart + 1 };
}

/** Keeps source offsets stable by blanking non-script characters but retaining every line break. */
function maskOutsideRegions(contents: string, regions: readonly SourceRegion[]): string {
  const masked = contents.replace(/[^\r\n]/g, ' ').split('');

  for (const region of regions) {
    for (let index = region.start; index < region.end; index += 1) {
      masked[index] = contents[index] as string;
    }
  }

  return masked.join('');
}

function prepareSource(fileName: string, contents: string): PreparedSource {
  const extension = sourceContainerExtension(fileName);
  if (!extension) return { contents, limitations: [] };

  const extraction = scriptRegions(contents);
  const regions = extraction.regions;
  if (extension === '.astro') {
    const frontmatter = astroFrontmatterRegion(contents);
    if (frontmatter) regions.unshift(frontmatter);
  }

  return {
    contents: maskOutsideRegions(contents, regions),
    limitations: [...sourceContainerLimitations(fileName), ...extraction.limitations],
  };
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    : false;
}

const isExported = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword);
const isDefault = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.DefaultKeyword);

/** JSX anywhere in a declaration's body is the deterministic signal for a React component. */
function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

function looksLikeComponentName(name: string): boolean {
  return PASCAL_CASE.test(name);
}

function extendsReactComponent(node: ts.ClassDeclaration): boolean {
  const heritage = node.heritageClauses ?? [];
  return heritage.some((clause) =>
    clause.types.some((type) => {
      const text = type.expression.getText();
      return text === 'Component' || text === 'PureComponent' || /^React\.(Pure)?Component$/.test(text);
    }),
  );
}

function complexityOf(node: ts.Node): { complexity: number; nestingDepth: number } {
  let decisions = 0;
  let maxNest = 0;

  const walk = (current: ts.Node, nest: number): void => {
    const isDecision =
      ts.isIfStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isCatchClause(current) ||
      ts.isConditionalExpression(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken));

    const next = isDecision ? nest + 1 : nest;
    if (isDecision) {
      decisions += 1;
      if (next > maxNest) maxNest = next;
    }
    ts.forEachChild(current, (child) => walk(child, next));
  };

  walk(node, 0);
  return { complexity: decisions + 1, nestingDepth: maxNest };
}

function classLcom(node: ts.ClassDeclaration): number {
  const fields = new Set<string>();
  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      fields.add(member.name.text);
    }
  }

  const methods: Array<Set<string>> = [];
  for (const member of node.members) {
    let body: ts.Block | ts.Expression | undefined;
    if (ts.isMethodDeclaration(member)) body = member.body;
    else if (
      ts.isPropertyDeclaration(member) &&
      member.initializer &&
      (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
    ) {
      body = member.initializer.body;
    }
    if (!body) continue;
    const used = new Set<string>();
    const visit = (current: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(current) &&
        current.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isIdentifier(current.name) &&
        fields.has(current.name.text)
      ) {
        used.add(current.name.text);
      }
      ts.forEachChild(current, visit);
    };
    visit(body);
    methods.push(used);
  }

  if (methods.length <= 1 || fields.size === 0) return 0;
  let disconnected = 0;
  let pairs = 0;
  for (let left = 0; left < methods.length; left += 1) {
    for (let right = left + 1; right < methods.length; right += 1) {
      pairs += 1;
      const shared = [...(methods[left] ?? [])].some((field) => methods[right]?.has(field));
      if (!shared) disconnected += 1;
    }
  }
  return pairs === 0 ? 0 : disconnected / pairs;
}

export function parseSourceFile(fileName: string, contents: string): ParsedFile {
  const prepared = prepareSource(fileName, contents);
  const sourceFile = ts.createSourceFile(
    fileName,
    prepared.contents,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );

  const imports: ParsedImport[] = [];
  const symbols: ParsedSymbol[] = [];
  const calls: ParsedCall[] = [];
  const parseErrors: string[] = [];
  const syntaxIssues: SyntaxIssue[] = [];

  const rawParseDiagnostics = (
    sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (rawParseDiagnostics) {
    for (const diagnostic of rawParseDiagnostics) {
      const position =
        diagnostic.start === undefined
          ? { line: 0, character: 0 }
          : sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
      syntaxIssues.push({
        line: position.line + 1,
        column: position.character + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      });
    }
  }

  const lineOf = (node: ts.Node): number => {
    try {
      return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    } catch {
      return 1;
    }
  };

  const endLineOf = (node: ts.Node): number => {
    try {
      return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    } catch {
      return lineOf(node);
    }
  };

  const addSymbol = (symbol: ParsedSymbol): void => {
    symbols.push(symbol);
  };

  function recordImportDeclaration(node: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({
        specifier: node.moduleSpecifier.getText(sourceFile),
        line: lineOf(node),
        kind: 'import',
        isTypeOnly: false,
        importedNames: [],
        isStarExport: false,
        isDynamicExpression: true,
      });
      return;
    }

    const clause = node.importClause;
    const importedNames: string[] = [];
    let isTypeOnly = clause?.isTypeOnly ?? false;

    if (clause?.name) importedNames.push('default');
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        // `import * as ns` consumes the whole module surface; individual names are unknown.
        importedNames.push('*');
      } else {
        for (const element of clause.namedBindings.elements) {
          importedNames.push((element.propertyName ?? element.name).text);
          if (element.isTypeOnly) isTypeOnly = true;
        }
      }
    }

    imports.push({
      specifier: node.moduleSpecifier.text,
      line: lineOf(node),
      kind: 'import',
      isTypeOnly,
      importedNames,
      isStarExport: false,
      isDynamicExpression: false,
    });
  }

  function recordExportDeclaration(node: ts.ExportDeclaration): void {
    if (!node.moduleSpecifier) {
      // `export { a, b }` re-exports local declarations; mark those symbols as exported.
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const localName = (element.propertyName ?? element.name).text;
          const existing = symbols.find((symbol) => symbol.name === localName);
          if (existing) {
            existing.isExported = true;
            if (element.name.text !== localName) existing.metadata.exportedAs = element.name.text;
          } else {
            addSymbol({
              name: localName,
              kind: 'unknown',
              isExported: true,
              isDefaultExport: element.name.text === 'default',
              startLine: lineOf(element),
              endLine: endLineOf(element),
              metadata: { exportedAs: element.name.text, isTypeOnly: node.isTypeOnly },
            });
          }
        }
      }
      return;
    }

    if (!ts.isStringLiteral(node.moduleSpecifier)) {
      parseErrors.push(`Non-literal export specifier on line ${lineOf(node)} was not resolved.`);
      return;
    }

    const isStarExport = !node.exportClause;
    const importedNames: string[] = [];

    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        const sourceName = (element.propertyName ?? element.name).text;
        importedNames.push(sourceName);
        addSymbol({
          name: element.name.text,
          kind: 'unknown',
          isExported: true,
          isDefaultExport: element.name.text === 'default',
          startLine: lineOf(element),
          endLine: endLineOf(element),
          metadata: {
            reExportedFrom: node.moduleSpecifier.text,
            isTypeOnly: node.isTypeOnly || element.isTypeOnly,
          },
        });
      }
    }

    imports.push({
      specifier: node.moduleSpecifier.text,
      line: lineOf(node),
      kind: 're-export',
      isTypeOnly: node.isTypeOnly,
      importedNames,
      isStarExport,
      isDynamicExpression: false,
    });
  }

  function recordCallLikeImport(node: ts.CallExpression): void {
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire =
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length > 0;

    if (!isDynamicImport && !isRequire) return;

    const argument = node.arguments[0];
    if (!argument) return;

    if (ts.isStringLiteral(argument)) {
      imports.push({
        specifier: argument.text,
        line: lineOf(node),
        kind: isDynamicImport ? 'dynamic-import' : 'require',
        isTypeOnly: false,
        importedNames: [],
        isStarExport: false,
        isDynamicExpression: false,
      });
      return;
    }

    // A computed specifier cannot be resolved statically; it is recorded so the UI can say so.
    imports.push({
      specifier: argument.getText(sourceFile).slice(0, 200),
      line: lineOf(node),
      kind: isDynamicImport ? 'dynamic-import' : 'require',
      isTypeOnly: false,
      importedNames: [],
      isStarExport: false,
      isDynamicExpression: true,
    });
  }

  function recordLocalCall(node: ts.CallExpression): void {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    if (ts.isIdentifier(node.expression) && node.expression.text === 'require') return;

    let callee: string | null = null;
    if (ts.isIdentifier(node.expression)) callee = node.expression.text;
    else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
      callee = node.expression.name.text;
    }
    if (!callee) return;
    calls.push({ callee, line: lineOf(node) });
  }

  function recordDeclaration(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      addSymbol({
        name,
        kind: looksLikeComponentName(name) && containsJsx(node) ? 'react-component' : 'function',
        isExported: isExported(node),
        isDefaultExport: isExported(node) && isDefault(node),
        startLine: lineOf(node),
        endLine: endLineOf(node),
        metadata: {
          isAsync: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
          paramCount: node.parameters.length,
          ...complexityOf(node),
        },
      });
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      const isComponent =
        extendsReactComponent(node) || (looksLikeComponentName(name) && containsJsx(node));
      addSymbol({
        name,
        kind: isComponent ? 'react-component' : 'class',
        isExported: isExported(node),
        isDefaultExport: isExported(node) && isDefault(node),
        startLine: lineOf(node),
        endLine: endLineOf(node),
        metadata: { lcom: classLcom(node) },
      });
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      addSymbol({
        name: node.name.text,
        kind: 'interface',
        isExported: isExported(node),
        isDefaultExport: false,
        startLine: lineOf(node),
        endLine: endLineOf(node),
        metadata: { isTypeOnly: true },
      });
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      addSymbol({
        name: node.name.text,
        kind: 'type',
        isExported: isExported(node),
        isDefaultExport: false,
        startLine: lineOf(node),
        endLine: endLineOf(node),
        metadata: { isTypeOnly: true },
      });
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      addSymbol({
        name: node.name.text,
        kind: 'enum',
        isExported: isExported(node),
        isDefaultExport: false,
        startLine: lineOf(node),
        endLine: endLineOf(node),
        metadata: {},
      });
      return;
    }

    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const initializer = declaration.initializer;

        let kind: SymbolKind = 'variable';
        const metadata: SymbolMetadata = {};

        if (
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          kind =
            looksLikeComponentName(name) && containsJsx(initializer) ? 'react-component' : 'function';
          metadata.isAsync = hasModifier(initializer, ts.SyntaxKind.AsyncKeyword);
          metadata.paramCount = initializer.parameters.length;
          Object.assign(metadata, complexityOf(initializer));
        }

        addSymbol({
          name,
          kind,
          isExported: exported,
          isDefaultExport: false,
          startLine: lineOf(declaration),
          endLine: endLineOf(declaration),
          metadata,
        });
      }
      return;
    }

    if (ts.isExportAssignment(node)) {
      // Covers both `export default X` and `export = X`.
      const name = ts.isIdentifier(node.expression) ? node.expression.text : 'default';
      const existing = symbols.find((symbol) => symbol.name === name);
      if (existing) {
        existing.isExported = true;
        existing.isDefaultExport = true;
        return;
      }
      addSymbol({
        name,
        kind: 'unknown',
        isExported: true,
        isDefaultExport: true,
        startLine: lineOf(node),
        endLine: endLineOf(node),
        metadata: {},
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      recordImportDeclaration(node);
    } else if (ts.isExportDeclaration(node)) {
      recordExportDeclaration(node);
    } else if (ts.isCallExpression(node)) {
      recordCallLikeImport(node);
      recordLocalCall(node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        imports.push({
          specifier: node.moduleReference.expression.text,
          line: lineOf(node),
          kind: 'require',
          isTypeOnly: false,
          importedNames: [node.name.text],
          isStarExport: false,
          isDynamicExpression: false,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  // Top-level declarations are walked first so that a later `export { x }` can find them.
  for (const statement of sourceFile.statements) {
    recordDeclaration(statement);
  }

  ts.forEachChild(sourceFile, visit);

  return { imports, symbols, calls, parseErrors, syntaxIssues, limitations: prepared.limitations };
}
