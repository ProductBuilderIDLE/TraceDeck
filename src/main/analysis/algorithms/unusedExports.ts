import type { SymbolKind } from '@shared/types';
import { FRAMEWORK_CONVENTION_PATTERNS } from '@shared/constants';
import { symbolNodeId } from '@shared/nodeIds';
import { createGlobMatchers, matchesAny, toPosixPath } from '../../utils/glob';
import type { GraphIndex } from './graphIndex';

export interface ExportedSymbolInput {
  filePath: string;
  symbolName: string;
  symbolKind: SymbolKind;
  line: number;
  isDefaultExport: boolean;
  /**
   * True when this row only forwards a declaration from another module, as in
   * `export { greet } from './greeter'`. The forwarded declaration is analysed on its own,
   * so flagging the forwarding row as well would report the same export twice.
   */
  isReExport?: boolean;
}

export interface UnusedExportOptions {
  /** Relative paths whose exports form a public API and are never candidates. */
  entryPoints: readonly string[];
  /** User exclusions, as `path` or `path#symbol`. */
  exclusions: readonly string[];
  /** Files whose export surface is uncertain, keyed by path, from the graph build. */
  barrelCaveats: ReadonlyMap<string, readonly string[]>;
  /** Paths declared as package entry points, e.g. package.json "main"/"exports". */
  packageEntryPoints: readonly string[];
}

export interface UnusedExportCandidate {
  filePath: string;
  symbolName: string;
  symbolKind: SymbolKind;
  line: number;
  nodeId: string;
  /** Reasons the result is less certain; a candidate with caveats is weaker evidence. */
  caveats: string[];
}

function isFrameworkConvention(filePath: string): boolean {
  const posix = toPosixPath(filePath);
  return FRAMEWORK_CONVENTION_PATTERNS.some((pattern) => pattern.test(posix));
}

/**
 * Finds exported symbols with no resolved incoming reference edge.
 *
 * This is deliberately conservative. Static analysis cannot see a symbol reached through a
 * namespace import, a computed property, a framework's file-based convention, or a consumer
 * outside the scanned folder — so anything touched by those situations is either excluded
 * outright or reported with an explicit caveat. The result is a list of *candidates* for a
 * human to check, never a claim that code is dead.
 */
export function findUnusedExportCandidates(
  symbols: readonly ExportedSymbolInput[],
  index: GraphIndex,
  options: UnusedExportOptions,
): UnusedExportCandidate[] {
  const entryPoints = new Set(options.entryPoints.map(toPosixPath));
  const packageEntryPoints = new Set(options.packageEntryPoints.map(toPosixPath));
  const exclusionMatchers = createGlobMatchers(
    options.exclusions.filter((exclusion) => !exclusion.includes('#')),
  );
  const symbolExclusions = new Set(
    options.exclusions.filter((exclusion) => exclusion.includes('#')).map(toPosixPath),
  );

  const candidates: UnusedExportCandidate[] = [];

  for (const symbol of symbols) {
    const filePath = toPosixPath(symbol.filePath);
    const nodeId = symbolNodeId(filePath, symbol.symbolName);

    if (symbol.isReExport) continue;
    if (entryPoints.has(filePath)) continue;
    if (packageEntryPoints.has(filePath)) continue;
    if (isFrameworkConvention(filePath)) continue;
    if (matchesAny(exclusionMatchers, filePath)) continue;
    if (symbolExclusions.has(`${filePath}#${symbol.symbolName}`)) continue;

    // Any resolved reference edge into the symbol means something imports it by name.
    if (index.edgesTo(nodeId).some((edge) => edge.edgeType === 'reference')) continue;

    const caveats: string[] = [];

    const fileCaveats = options.barrelCaveats.get(filePath);
    if (fileCaveats && fileCaveats.length > 0) caveats.push(...fileCaveats);

    if (symbol.isDefaultExport) {
      caveats.push('Default exports can be imported under any name, which weakens this result.');
    }

    if (symbol.symbolKind === 'react-component') {
      caveats.push('Components are sometimes referenced only by a framework route or registry.');
    }

    candidates.push({
      filePath,
      symbolName: symbol.symbolName,
      symbolKind: symbol.symbolKind,
      line: symbol.line,
      nodeId,
      caveats,
    });
  }

  return candidates.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line,
  );
}

/** Reads entry-point paths declared by package.json, so a published API is not flagged. */
export function packageEntryPointsFrom(packageJson: unknown): string[] {
  if (typeof packageJson !== 'object' || packageJson === null) return [];

  const manifest = packageJson as Record<string, unknown>;
  const found = new Set<string>();

  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    found.add(toPosixPath(value.replace(/^\.\//, '')));
  };

  add(manifest['main']);
  add(manifest['module']);
  add(manifest['browser']);
  add(manifest['types']);

  const collectExports = (value: unknown, depth = 0): void => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      add(value);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        collectExports(nested, depth + 1);
      }
    }
  };
  collectExports(manifest['exports']);

  const bin = manifest['bin'];
  if (typeof bin === 'string') add(bin);
  else if (typeof bin === 'object' && bin !== null) {
    for (const value of Object.values(bin as Record<string, unknown>)) add(value);
  }

  return [...found];
}
