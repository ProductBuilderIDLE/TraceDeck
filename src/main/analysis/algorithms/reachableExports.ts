import type { ReviewLimitation } from '@shared/changeReview';
import type { SymbolKind } from '@shared/types';
import { canonicalSha256, compareCodePoints } from '../../services/changeReview/canonical';
import { toPosixPath } from '../../utils/glob';

export interface ExportSymbolFact {
  name: string;
  exportedName: string;
  kind: SymbolKind;
  line: number;
  isDefault: boolean;
  reExportedFrom: string | null;
}

export interface ExportLinkFact {
  targetPath: string | null;
  specifier: string;
  isStar: boolean;
}

export interface ExportModuleFact {
  path: string;
  symbols: ExportSymbolFact[];
  links: ExportLinkFact[];
}

export interface ReachableExportRecord {
  entryPoint: string;
  exportedName: string;
  symbolKind: SymbolKind;
  originPath: string;
  line: number | null;
}

interface ExportOrigin {
  symbolKind: SymbolKind;
  originPath: string;
  line: number;
}

interface NormalizedModuleFact extends ExportModuleFact {
  path: string;
}

function originKey(origin: ExportOrigin): string {
  return `${origin.originPath}\0${origin.symbolKind}`;
}

function exportKey(record: ReachableExportRecord): string {
  return [record.entryPoint, record.exportedName, record.symbolKind, record.originPath].join('\0');
}

function sortedUniqueOrigins(origins: readonly ExportOrigin[]): ExportOrigin[] {
  const byIdentity = new Map<string, ExportOrigin>();
  for (const origin of origins) {
    const key = originKey(origin);
    const existing = byIdentity.get(key);
    if (!existing || origin.line < existing.line) byIdentity.set(key, origin);
  }
  return [...byIdentity.values()].sort((left, right) => (
    compareCodePoints(originKey(left), originKey(right)) || left.line - right.line
  ));
}

function normalizedModules(modules: readonly ExportModuleFact[]): Map<string, NormalizedModuleFact> {
  const result = new Map<string, NormalizedModuleFact>();
  const ordered = [...modules].sort((left, right) => compareCodePoints(
    toPosixPath(left.path),
    toPosixPath(right.path),
  ));

  for (const fact of ordered) {
    const path = toPosixPath(fact.path);
    result.set(path, {
      path,
      symbols: [...fact.symbols].sort((left, right) => (
        compareCodePoints(left.exportedName, right.exportedName)
        || compareCodePoints(left.name, right.name)
        || left.line - right.line
      )),
      links: [...fact.links]
        .map((candidate) => ({
          ...candidate,
          targetPath: candidate.targetPath === null ? null : toPosixPath(candidate.targetPath),
        }))
        .sort((left, right) => (
          compareCodePoints(left.specifier, right.specifier)
          || compareCodePoints(left.targetPath ?? '', right.targetPath ?? '')
          || Number(left.isStar) - Number(right.isStar)
        )),
    });
  }
  return result;
}

export function discoverReachableExports(
  entryPoints: readonly string[],
  modules: readonly ExportModuleFact[],
): { exports: ReachableExportRecord[]; limitations: ReviewLimitation[] } {
  const modulesByPath = normalizedModules(modules);
  const namesByModule = new Map<string, Set<string>>();
  const limitationByKey = new Map<string, ReviewLimitation>();

  const addLimitation = (code: string, message: string, paths: readonly string[]): void => {
    const orderedPaths = [...new Set(paths.map(toPosixPath))].sort(compareCodePoints);
    const identity = { scope: 'review' as const, code, paths: orderedPaths };
    const stableKey = canonicalSha256(identity);
    if (limitationByKey.has(stableKey)) return;
    limitationByKey.set(stableKey, {
      itemType: 'limitation',
      stableKey,
      ...identity,
      message,
      omittedCount: 0,
    });
  };

  for (const [path, fact] of modulesByPath) {
    namesByModule.set(path, new Set(fact.symbols.map((candidate) => candidate.exportedName)));
  }

  const normalizedEntryPoints = [...new Set(entryPoints.map(toPosixPath))].sort(compareCodePoints);
  const reachableModules = new Set(normalizedEntryPoints.filter((path) => modulesByPath.has(path)));
  const pendingModules = [...reachableModules].sort(compareCodePoints);
  while (pendingModules.length > 0) {
    const path = pendingModules.shift() as string;
    const fact = modulesByPath.get(path) as NormalizedModuleFact;
    for (const candidate of fact.links) {
      if (candidate.targetPath === null || !modulesByPath.has(candidate.targetPath)) {
        addLimitation(
          'UNRESOLVED_REEXPORT_TARGET',
          `The re-export target "${candidate.specifier}" from "${path}" could not be resolved.`,
          [path],
        );
        continue;
      }
      if (reachableModules.has(candidate.targetPath)) continue;
      reachableModules.add(candidate.targetPath);
      pendingModules.push(candidate.targetPath);
      pendingModules.sort(compareCodePoints);
    }
  }

  // Star-export names form a monotone fixed point. Computing that point first makes cycles
  // deterministic without treating module insertion order as evidence.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [path, fact] of modulesByPath) {
      const names = namesByModule.get(path) as Set<string>;
      for (const candidate of fact.links) {
        if (!candidate.isStar || candidate.targetPath === null) continue;
        const targetNames = namesByModule.get(candidate.targetPath);
        if (!targetNames) continue;
        for (const name of targetNames) {
          if (name === 'default' || names.has(name)) continue;
          names.add(name);
          changed = true;
        }
      }
    }
  }

  const resolveName = (
    modulePath: string,
    exportedName: string,
    visiting: ReadonlySet<string>,
  ): ExportOrigin[] => {
    const pairKey = `${modulePath}\0${exportedName}`;
    if (visiting.has(pairKey)) return [];
    const fact = modulesByPath.get(modulePath);
    if (!fact) return [];
    const nextVisiting = new Set(visiting);
    nextVisiting.add(pairKey);

    const direct = fact.symbols.filter((candidate) => candidate.exportedName === exportedName);
    const own = direct.filter((candidate) => candidate.reExportedFrom === null);
    if (own.length > 0) {
      const declaration = own[0] as ExportSymbolFact;
      return [{ symbolKind: declaration.kind, originPath: modulePath, line: declaration.line }];
    }

    const named = direct.filter((candidate) => candidate.reExportedFrom !== null);
    if (named.length > 0) {
      const origins: ExportOrigin[] = [];
      for (const declaration of named) {
        const matchingLinks = fact.links.filter((candidate) => (
          !candidate.isStar && candidate.specifier === declaration.reExportedFrom
        ));
        if (matchingLinks.length === 0) {
          addLimitation(
            'UNRESOLVED_REEXPORT_TARGET',
            `The re-export target "${declaration.reExportedFrom ?? ''}" from "${modulePath}" could not be resolved.`,
            [modulePath],
          );
        }
        for (const candidate of matchingLinks) {
          if (candidate.targetPath === null || !modulesByPath.has(candidate.targetPath)) continue;
          origins.push(...resolveName(candidate.targetPath, declaration.name, nextVisiting));
        }
      }
      return sortedUniqueOrigins(origins);
    }

    if (exportedName === 'default') return [];
    const starOrigins: ExportOrigin[] = [];
    for (const candidate of fact.links) {
      if (!candidate.isStar || candidate.targetPath === null || !modulesByPath.has(candidate.targetPath)) {
        continue;
      }
      starOrigins.push(...resolveName(candidate.targetPath, exportedName, nextVisiting));
    }
    const uniqueOrigins = sortedUniqueOrigins(starOrigins);
    if (uniqueOrigins.length > 1) {
      addLimitation(
        'AMBIGUOUS_STAR_REEXPORT',
        `The export "${exportedName}" from "${modulePath}" has several star re-export origins.`,
        [modulePath],
      );
      return [];
    }
    return uniqueOrigins;
  };

  const exportByIdentity = new Map<string, ReachableExportRecord>();
  for (const entryPoint of normalizedEntryPoints) {
    const names = [...(namesByModule.get(entryPoint) ?? [])].sort(compareCodePoints);
    for (const exportedName of names) {
      for (const origin of resolveName(entryPoint, exportedName, new Set())) {
        const record: ReachableExportRecord = {
          entryPoint,
          exportedName,
          symbolKind: origin.symbolKind,
          originPath: origin.originPath,
          line: origin.line,
        };
        const key = exportKey(record);
        const existing = exportByIdentity.get(key);
        if (!existing || (record.line ?? Number.MAX_SAFE_INTEGER) < (existing.line ?? Number.MAX_SAFE_INTEGER)) {
          exportByIdentity.set(key, record);
        }
      }
    }
  }

  return {
    exports: [...exportByIdentity.values()].sort((left, right) => (
      compareCodePoints(exportKey(left), exportKey(right))
      || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
    )),
    limitations: [...limitationByKey.values()].sort((left, right) => (
      compareCodePoints(left.stableKey, right.stableKey)
    )),
  };
}
