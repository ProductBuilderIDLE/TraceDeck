import type { EdgeMetadata, EdgeType, NodeType } from '@shared/types';
import { fileNodeId, symbolNodeId } from '@shared/nodeIds';
import { toPosixPath } from '../utils/glob';
import type { ImportKind, ParsedFile } from './parser';
import { resolveImport, type ResolverContext, type UnresolvedReason } from './resolver';

export interface FileToBuild {
  relativePath: string;
  absolutePath: string;
  parsed: ParsedFile;
}

export interface BuiltEdge {
  fromNodeType: NodeType;
  fromNodeId: string;
  toNodeType: NodeType;
  toNodeId: string;
  edgeType: EdgeType;
  /** Relative path of the file that declares this edge; maps to files.id at persist time. */
  sourceRelativePath: string;
  sourceLine: number | null;
  metadata: EdgeMetadata;
}

export interface UnresolvedRecord {
  filePath: string;
  specifier: string;
  line: number | null;
  reason: UnresolvedReason;
  detail: string;
}

export interface BuiltGraph {
  edges: BuiltEdge[];
  unresolved: UnresolvedRecord[];
  /** Files whose export surface could not be fully determined, e.g. through `export *`. */
  barrelCaveats: Map<string, string[]>;
}

/** An unresolvable target still gets a node so the UI can show what the import pointed at. */
export function unresolvedNodeId(specifier: string): string {
  return `file:${specifier}`;
}

const IMPORT_KIND_TO_EDGE: Record<ImportKind, EdgeType> = {
  import: 'import',
  'dynamic-import': 'dynamic-import',
  require: 'require',
  're-export': 're-export',
};

interface ExportSurface {
  /** exportedName -> the identifier the declaration actually uses in this file. */
  own: Map<string, string>;
  /** exportedName -> where it actually comes from. */
  named: Map<string, { specifier: string; sourceName: string }>;
  /** Specifiers this file re-exports wholesale via `export *`. */
  stars: string[];
}

/** The file and identifier where an exported name is actually declared. */
export interface Declaration {
  filePath: string;
  symbolName: string;
}

function buildExportSurfaces(files: readonly FileToBuild[]): Map<string, ExportSurface> {
  const surfaces = new Map<string, ExportSurface>();

  for (const file of files) {
    const surface: ExportSurface = { own: new Map(), named: new Map(), stars: [] };

    for (const symbol of file.parsed.symbols) {
      if (!symbol.isExported) continue;
      const exportedName = symbol.metadata.exportedAs ?? symbol.name;

      if (symbol.metadata.reExportedFrom) {
        surface.named.set(exportedName, {
          specifier: symbol.metadata.reExportedFrom,
          sourceName: symbol.name,
        });
      } else {
        surface.own.set(exportedName, symbol.name);
      }

      // `import x from './m'` records the imported name as "default", so the declaring file
      // must answer to that name as well as to the declaration's own identifier.
      if (symbol.isDefaultExport) surface.own.set('default', symbol.name);
    }

    for (const record of file.parsed.imports) {
      if (record.kind === 're-export' && record.isStarExport && !record.isDynamicExpression) {
        surface.stars.push(record.specifier);
      }
    }

    surfaces.set(file.relativePath, surface);
  }

  return surfaces;
}

/**
 * Builds the dependency graph from parsed files.
 *
 * Import edges connect files. Reference edges connect an importing file to the *declaring*
 * symbol, following barrel files so that `import { Button } from './components'` is recorded
 * against the component's own declaration rather than against the barrel that forwards it.
 * Where a barrel's `export *` makes the origin ambiguous, no reference edge is invented and
 * the ambiguity is recorded as a caveat instead.
 */
export function buildGraph(files: readonly FileToBuild[], context: ResolverContext): BuiltGraph {
  const edges: BuiltEdge[] = [];
  const unresolved: UnresolvedRecord[] = [];
  const barrelCaveats = new Map<string, string[]>();

  const byRelativePath = new Map(files.map((file) => [file.relativePath, file]));
  const absoluteToRelative = new Map(
    files.map((file) => [toPosixPath(file.absolutePath), file.relativePath]),
  );
  const surfaces = buildExportSurfaces(files);

  const addCaveat = (filePath: string, message: string): void => {
    const existing = barrelCaveats.get(filePath) ?? [];
    if (!existing.includes(message)) existing.push(message);
    barrelCaveats.set(filePath, existing);
  };

  /** Resolves a specifier to a file already in the scan, or null. */
  const resolveToRelative = (specifier: string, fromAbsolutePath: string): string | null => {
    const result = resolveImport(specifier, fromAbsolutePath, context);
    if (result.status !== 'resolved') return null;
    return absoluteToRelative.get(toPosixPath(result.absolutePath)) ?? null;
  };

  /**
   * Walks re-export chains to find the file that actually declares `name`.
   * Returns null when the chain is ambiguous or leaves the project.
   */
  const findDeclaration = (
    filePath: string,
    name: string,
    seen: Set<string>,
  ): Declaration | null => {
    if (seen.has(`${filePath}#${name}`)) return null;
    seen.add(`${filePath}#${name}`);

    const surface = surfaces.get(filePath);
    const file = byRelativePath.get(filePath);
    if (!surface || !file) return null;

    const declared = surface.own.get(name);
    if (declared !== undefined) return { filePath, symbolName: declared };

    const named = surface.named.get(name);
    if (named) {
      const target = resolveToRelative(named.specifier, file.absolutePath);
      // The barrel declares the name itself when its source is outside the scan.
      if (!target) return { filePath, symbolName: name };
      return findDeclaration(target, named.sourceName, seen);
    }

    // `export *` forwards every name from its target, so each star branch is searched.
    const candidates: Declaration[] = [];
    for (const specifier of surface.stars) {
      const target = resolveToRelative(specifier, file.absolutePath);
      if (!target) {
        addCaveat(filePath, `"export * from '${specifier}'" could not be resolved.`);
        continue;
      }
      const found = findDeclaration(target, name, seen);
      if (found) candidates.push(found);
    }

    if (candidates.length === 1) return candidates[0] as Declaration;
    if (candidates.length > 1) {
      addCaveat(
        filePath,
        `"${name}" is exported by more than one "export *" source; its origin is ambiguous.`,
      );
    }
    return null;
  };

  for (const file of files) {
    const fromId = fileNodeId(file.relativePath);

    // A file's own exported symbols hang off it, which is what folder/symbol views expand.
    for (const symbol of file.parsed.symbols) {
      if (!symbol.isExported) continue;
      edges.push({
        fromNodeType: 'file',
        fromNodeId: fromId,
        toNodeType: 'symbol',
        toNodeId: symbolNodeId(file.relativePath, symbol.name),
        edgeType: 'export',
        sourceRelativePath: file.relativePath,
        sourceLine: symbol.startLine,
        metadata: {
          isTypeOnly: symbol.metadata.isTypeOnly === true,
          ...(symbol.metadata.reExportedFrom
            ? { specifier: symbol.metadata.reExportedFrom }
            : {}),
        },
      });
    }

    for (const record of file.parsed.imports) {
      const edgeType = IMPORT_KIND_TO_EDGE[record.kind];

      if (record.isDynamicExpression) {
        unresolved.push({
          filePath: file.relativePath,
          specifier: record.specifier,
          line: record.line,
          reason: 'dynamic-expression',
          detail: 'The module specifier is computed at runtime and cannot be resolved statically.',
        });
        edges.push({
          fromNodeType: 'file',
          fromNodeId: fromId,
          toNodeType: 'file',
          toNodeId: unresolvedNodeId(record.specifier),
          edgeType,
          sourceRelativePath: file.relativePath,
          sourceLine: record.line,
          metadata: { specifier: record.specifier, unresolved: true, dynamicExpression: true },
        });
        continue;
      }

      const resolution = resolveImport(record.specifier, file.absolutePath, context);

      if (resolution.status !== 'resolved') {
        unresolved.push({
          filePath: file.relativePath,
          specifier: record.specifier,
          line: record.line,
          reason: resolution.reason,
          detail: resolution.detail,
        });
        edges.push({
          fromNodeType: 'file',
          fromNodeId: fromId,
          toNodeType: 'file',
          toNodeId: unresolvedNodeId(record.specifier),
          edgeType,
          sourceRelativePath: file.relativePath,
          sourceLine: record.line,
          metadata: {
            specifier: record.specifier,
            unresolved: true,
            external: resolution.reason === 'external-package',
            isTypeOnly: record.isTypeOnly,
          },
        });
        continue;
      }

      const targetRelative = absoluteToRelative.get(toPosixPath(resolution.absolutePath));
      if (!targetRelative) continue;

      edges.push({
        fromNodeType: 'file',
        fromNodeId: fromId,
        toNodeType: 'file',
        toNodeId: fileNodeId(targetRelative),
        edgeType,
        sourceRelativePath: file.relativePath,
        sourceLine: record.line,
        metadata: {
          specifier: record.specifier,
          isTypeOnly: record.isTypeOnly,
          importedNames: record.importedNames,
          ...(record.isStarExport ? { isStarExport: true } : {}),
          // Persisted so an incremental rescan can rebuild namespace-qualified call edges
          // from stored rows without re-parsing the file.
          ...(record.namespaceBinding ? { namespaceBinding: record.namespaceBinding } : {}),
        },
      });

      if (record.isStarExport) {
        addCaveat(
          file.relativePath,
          `"export * from '${record.specifier}'" forwards names that cannot be listed statically.`,
        );
        continue;
      }

      for (const name of record.importedNames) {
        if (name === '*') {
          addCaveat(
            targetRelative,
            `Imported as a namespace by ${file.relativePath}; individual symbol usage is unknown.`,
          );
          continue;
        }

        const declaration = findDeclaration(targetRelative, name, new Set());
        if (!declaration) continue;

        edges.push({
          fromNodeType: 'file',
          fromNodeId: fromId,
          toNodeType: 'symbol',
          toNodeId: symbolNodeId(declaration.filePath, declaration.symbolName),
          edgeType: 'reference',
          sourceRelativePath: file.relativePath,
          sourceLine: record.line,
          metadata: {
            specifier: record.specifier,
            // Records that the reference reached its target through a barrel file.
            ...(declaration.filePath === targetRelative ? {} : { isStarExport: true }),
          },
        });
      }
    }

    const localCallees = new Set(
      file.parsed.symbols
        .filter((symbol) => symbol.kind === 'function' || symbol.kind === 'react-component')
        .map((symbol) => symbol.name),
    );

    const namespaceImports = new Map<string, (typeof file.parsed.imports)[number]>();
    for (const record of file.parsed.imports) {
      if (record.namespaceBinding && !record.isDynamicExpression) {
        namespaceImports.set(record.namespaceBinding, record);
      }
    }

    for (const call of file.parsed.calls) {
      if (call.isPropertyAccess) {
        // A property access names a member of whatever the receiver holds, and the receiver's
        // value is not knowable without type information. Matching the bare member name
        // against this file's imports would attribute `logger.send()` to an imported `send`,
        // inventing an edge the code does not contain. A namespace import is the exception:
        // `ns.send()` can only mean the module bound to `ns`, so that one is followed.
        const record = call.receiver ? namespaceImports.get(call.receiver) : undefined;
        if (!record) continue;

        const resolution = resolveImport(record.specifier, file.absolutePath, context);
        if (resolution.status !== 'resolved') continue;
        const targetRelative = absoluteToRelative.get(toPosixPath(resolution.absolutePath));
        if (!targetRelative) continue;

        const declaration = findDeclaration(targetRelative, call.callee, new Set());
        edges.push({
          fromNodeType: 'file',
          fromNodeId: fromId,
          toNodeType: declaration ? 'symbol' : 'file',
          toNodeId: declaration
            ? symbolNodeId(declaration.filePath, declaration.symbolName)
            : fileNodeId(targetRelative),
          edgeType: 'call',
          sourceRelativePath: file.relativePath,
          sourceLine: call.line,
          metadata: {
            callee: call.callee,
            calleeReceiver: call.receiver ?? undefined,
            specifier: record.specifier,
          },
        });
        continue;
      }

      const importRecord = file.parsed.imports.find((record) =>
        record.importedNames.includes(call.callee),
      );
      if (importRecord && !importRecord.isDynamicExpression) {
        const resolution = resolveImport(importRecord.specifier, file.absolutePath, context);
        if (resolution.status !== 'resolved') continue;
        const targetRelative = absoluteToRelative.get(toPosixPath(resolution.absolutePath));
        if (!targetRelative) continue;
        const declaration = findDeclaration(targetRelative, call.callee, new Set());
        edges.push({
          fromNodeType: 'file',
          fromNodeId: fromId,
          toNodeType: declaration ? 'symbol' : 'file',
          toNodeId: declaration
            ? symbolNodeId(declaration.filePath, declaration.symbolName)
            : fileNodeId(targetRelative),
          edgeType: 'call',
          sourceRelativePath: file.relativePath,
          sourceLine: call.line,
          metadata: { callee: call.callee, specifier: importRecord.specifier },
        });
        continue;
      }

      if (!localCallees.has(call.callee)) continue;
      edges.push({
        fromNodeType: 'file',
        fromNodeId: fromId,
        toNodeType: 'symbol',
        toNodeId: symbolNodeId(file.relativePath, call.callee),
        edgeType: 'call',
        sourceRelativePath: file.relativePath,
        sourceLine: call.line,
        metadata: { callee: call.callee },
      });
    }
  }

  return { edges, unresolved, barrelCaveats };
}
