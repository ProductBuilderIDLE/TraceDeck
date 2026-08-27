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

export interface ParsedFile {
  imports: ParsedImport[];
  symbols: ParsedSymbol[];
  /** Every identifier read in the file, used to resolve symbol-level reference edges. */
  referencedIdentifiers: string[];
  parseErrors: string[];
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

export function parseSourceFile(fileName: string, contents: string): ParsedFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    contents,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );

  const imports: ParsedImport[] = [];
  const symbols: ParsedSymbol[] = [];
  const referencedIdentifiers = new Set<string>();
  const parseErrors: string[] = [];

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
        metadata: {},
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
    } else if (ts.isIdentifier(node)) {
      // Declaration names are recorded separately; only reads are reference candidates.
      const parent = node.parent;
      const isDeclarationName =
        parent &&
        'name' in parent &&
        (parent as { name?: ts.Node }).name === node;
      if (!isDeclarationName) referencedIdentifiers.add(node.text);
    }

    ts.forEachChild(node, visit);
  }

  // Top-level declarations are walked first so that a later `export { x }` can find them.
  for (const statement of sourceFile.statements) {
    recordDeclaration(statement);
  }

  ts.forEachChild(sourceFile, visit);

  return {
    imports,
    symbols,
    referencedIdentifiers: [...referencedIdentifiers],
    parseErrors,
  };
}
