import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runScan } from '@main/analysis/scanner';
import { DataStore } from '@main/db';
import { openDatabase } from '@main/db/connection';
import { canonicalSha256 } from '@main/services/changeReview/canonical';
import { extractReviewSnapshot, type ReviewSnapshot } from '@main/services/changeReview/snapshot';
import { fileNodeId, symbolNodeId } from '@shared/nodeIds';
import type {
  EdgeType,
  FindingDetails,
  FindingType,
  Project,
  ProjectFileAnalysisStatus,
  ScanSummary,
  Severity,
  SymbolKind,
} from '@shared/types';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/sample-project');
const stores: DataStore[] = [];

interface SeedOptions {
  reverse?: boolean;
  typeCheck?: boolean;
}

interface SeededReview {
  store: DataStore;
  project: Project;
  ruleId: number;
}

function scanSummary(rootPath: string): ScanSummary {
  return {
    totalFiles: 7,
    inventoryFiles: 8,
    graphEligibleFiles: 7,
    textOnlyFiles: 1,
    binaryFiles: 0,
    ignoredFiles: 0,
    unavailableFiles: 0,
    parsedFiles: 7,
    skippedUnchangedFiles: 0,
    removedFiles: 0,
    totalSymbols: 5,
    totalEdges: 8,
    unresolvedImports: 1,
    dynamicImports: 0,
    externalDependencies: 0,
    cycles: 1,
    unusedExportCandidates: 0,
    architectureViolations: 1,
    typeCheck: null,
    durationMs: 42,
    limitations: [
      `Discovery searched under "${rootPath}" (paths: src/configured.ts).`,
      'src/origin.ts: export evidence was partial.',
    ],
  };
}

function reverseWhen<T>(items: T[], reverse: boolean): T[] {
  return reverse ? [...items].reverse() : items;
}

function seedReview(options: SeedOptions = {}): SeededReview {
  const reverse = options.reverse ?? false;
  const store = new DataStore(openDatabase({ filePath: ':memory:' }));
  stores.push(store);
  let project = store.projects.createOrTouch('snapshot-fixture', FIXTURE_ROOT);
  project = store.projects.updateConfiguration(project.id, {
    excludePatterns: ['generated\\**', 'vendor/**'],
    entryPoints: ['src/configured.ts', 'src/python.py'],
    respectGitignore: true,
    includeTestFiles: true,
    typeCheck: options.typeCheck ?? true,
    unusedExportExclusions: ['src\\ignored.ts#unused', 'src/other.ts'],
  }) as Project;
  const scan = store.scans.start(project.id, 'scan-commit');

  const inventoryPaths: Array<[string, ProjectFileAnalysisStatus]> = [
    ['src/configured.ts', 'eligible'],
    ['src/cycle-a.ts', 'eligible'],
    ['src/cycle-b.ts', 'eligible'],
    ['src/inferred-root.ts', 'eligible'],
    ['src/index.ts', 'eligible'],
    ['src/origin.ts', 'eligible'],
    ['src/python.py', 'eligible'],
    ['README.md', 'text-only'],
  ];
  store.projectFiles.upsertMany(reverseWhen(inventoryPaths.map(([relativePath, analysisStatus], index) => ({
    projectId: project.id,
    relativePath,
    absolutePath: resolve(FIXTURE_ROOT, relativePath),
    scanId: scan.id,
    entryKind: 'regular' as const,
    extension: relativePath.slice(relativePath.lastIndexOf('.')),
    sizeBytes: 100 + index,
    modifiedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    contentKind: 'text' as const,
    encoding: 'utf-8',
    contentHash: `inventory-${relativePath}`,
    isGitIgnored: false,
    gitignoreRule: null,
    isUserExcluded: false,
    analysisStatus,
    analysisReason: analysisStatus === 'eligible' ? 'Supported source file.' : 'Inventory-only text file.',
  })), reverse));

  const graphPaths = inventoryPaths
    .map(([relativePath]) => relativePath)
    .filter((relativePath) => relativePath !== 'README.md');
  const fileIds = store.files.upsertMany(reverseWhen(graphPaths.map((relativePath, index) => ({
    projectId: project.id,
    relativePath,
    absolutePath: resolve(FIXTURE_ROOT, relativePath),
    extension: relativePath.slice(relativePath.lastIndexOf('.')),
    contentHash: `graph-${relativePath}`,
    modifiedAt: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    isEntryPoint: relativePath === 'src/index.ts' || relativePath === 'src/inferred-root.ts',
    scanId: scan.id,
  })), reverse));

  const symbolInput = (
    relativePath: string,
    name: string,
    kind: SymbolKind,
    line: number,
    metadata: { reExportedFrom?: string; exportedAs?: string } = {},
  ) => ({
    projectId: project.id,
    fileId: fileIds.get(relativePath) as number,
    name,
    kind,
    isExported: true,
    isDefaultExport: false,
    startLine: line,
    endLine: line,
    metadata,
    scanId: scan.id,
  });
  store.symbols.insertMany(reverseWhen([
    symbolInput('src/configured.ts', 'configured', 'function', 4),
    symbolInput('src/index.ts', 'publicValue', 'unknown', 2, { reExportedFrom: './origin' }),
    symbolInput('src/origin.ts', 'publicValue', 'interface', 12),
    symbolInput('src/inferred-root.ts', 'hidden', 'variable', 1),
    symbolInput('src/python.py', 'pythonValue', 'function', 1),
  ], reverse));

  const edgeInput = (
    fromPath: string,
    toPath: string,
    edgeType: EdgeType,
    sourceLine: number | null,
    metadata: {
      specifier?: string;
      unresolved?: boolean;
      isTypeOnly?: boolean;
      importedNames?: string[];
      isStarExport?: boolean;
    } = {},
  ) => ({
    projectId: project.id,
    fromNodeType: 'file' as const,
    fromNodeId: fileNodeId(fromPath),
    toNodeType: 'file' as const,
    toNodeId: fileNodeId(toPath),
    edgeType,
    sourceFileId: fileIds.get(fromPath) ?? null,
    sourceLine,
    metadata,
    scanId: scan.id,
  });
  const edges = [
    edgeInput('src/configured.ts', 'src/origin.ts', 'import', 7, { specifier: './origin' }),
    edgeInput('src/configured.ts', 'src/origin.ts', 'import', 5, { specifier: './origin.js' }),
    edgeInput('src/configured.ts', 'src/origin.ts', 'import', 5, { specifier: './origin' }),
    edgeInput('src/configured.ts', 'src/origin.ts', 'import', 9, { specifier: './origin', isTypeOnly: true }),
    edgeInput('src/index.ts', 'src/origin.ts', 're-export', 2, {
      specifier: './origin',
      importedNames: ['publicValue'],
    }),
    edgeInput('src/cycle-a.ts', 'src/cycle-b.ts', 'import', 1, { specifier: './cycle-b' }),
    edgeInput('src/cycle-b.ts', 'src/cycle-a.ts', 'require', 2, { specifier: './cycle-a' }),
    edgeInput('src/configured.ts', 'unresolved:missing', 'import', 20, {
      specifier: './missing',
      unresolved: true,
    }),
    edgeInput('src/configured.ts', 'src/origin.ts', 'reference', 21, { specifier: './origin' }),
    {
      ...edgeInput('src/configured.ts', 'src/origin.ts', 'export', 4),
      toNodeType: 'symbol' as const,
      toNodeId: symbolNodeId('src/configured.ts', 'configured'),
    },
  ];
  store.edges.insertMany(reverseWhen(edges, reverse));

  const ruleId = 41;
  const insertRule = store.db.prepare(
    `INSERT INTO architecture_rules
       (id, project_id, name, enabled, rule_type, source_pattern, target_pattern,
        configuration_json, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  const rules = [
    {
      id: ruleId,
      name: 'Configured cannot import origin',
      sourcePattern: 'src\\configured.ts',
      targetPattern: 'src\\origin.ts',
      configuration: { severity: 'high', exceptions: ['src\\z.ts', 'src/a.ts'] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
    // A second enabled rule makes fingerprint ordering observable without changing findings.
    {
      id: 17,
      name: 'Zeta rule',
      sourcePattern: 'z/**',
      targetPattern: 'a/**',
      configuration: { severity: 'low', exceptions: [] },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-02-01T00:00:00.000Z',
    },
  ];
  for (const rule of reverseWhen(rules, reverse)) {
    insertRule.run(
      rule.id,
      project.id,
      rule.name,
      'forbid-import',
      rule.sourcePattern,
      rule.targetPattern,
      JSON.stringify(rule.configuration),
      rule.createdAt,
      rule.updatedAt,
    );
  }

  const finding = (
    findingType: FindingType,
    severity: Severity,
    fingerprint: string,
    details: FindingDetails,
  ) => ({
    projectId: project.id,
    scanId: scan.id,
    findingType,
    severity,
    title: `${findingType} title`,
    description: `${findingType} description`,
    relatedNodeIds: details.kind === 'architecture-violation'
      ? [fileNodeId(details.sourcePath), fileNodeId(details.targetPath)]
      : [fileNodeId('src/configured.ts')],
    details,
    fingerprint,
  });
  store.findings.replaceForScan(project.id, scan.id, [
    'syntax-error',
    'type-error',
    'architecture-violation',
    'circular-dependency',
  ], reverseWhen([
    finding('syntax-error', 'high', 'syntax-fingerprint', {
      kind: 'syntax-error',
      filePath: 'src/configured.ts',
      line: 3,
      column: 2,
      code: 1005,
      message: 'Expected token.',
    }),
    finding('type-error', 'high', 'type-fingerprint', {
      kind: 'type-error',
      filePath: 'src/configured.ts',
      line: 6,
      column: 4,
      code: 2322,
      category: 'error',
      message: 'Type mismatch.',
    }),
    finding('architecture-violation', 'high', 'architecture-row-fingerprint', {
      kind: 'architecture-violation',
      ruleId,
      ruleName: 'Configured cannot import origin',
      sourcePath: 'src/configured.ts',
      targetPath: 'src/origin.ts',
      line: 7,
      specifier: './origin',
    }),
    finding('circular-dependency', 'medium', 'cycle-fingerprint', {
      kind: 'cycle',
      cyclePath: ['src/cycle-a.ts', 'src/cycle-b.ts', 'src/cycle-a.ts'],
      edges: [],
    }),
  ], reverse));
  const syntaxFinding = store.findings.list(project.id, { includeDismissed: true })
    .find((candidate) => candidate.findingType === 'syntax-error');
  if (syntaxFinding) store.findings.setDismissed(syntaxFinding.id, true);

  store.scans.complete(scan.id, {
    status: 'completed',
    totalFiles: 7,
    parsedFiles: 7,
    errorCount: 2,
    summary: scanSummary(project.rootPath),
  });
  return { store, project, ruleId };
}

function extract(seeded: SeededReview, side: 'baseline' | 'target' = 'baseline'): ReviewSnapshot {
  return extractReviewSnapshot({
    store: seeded.store,
    project: seeded.project,
    side,
    baseCommit: 'a'.repeat(40),
    baseTreeId: 'b'.repeat(40),
    workingTreeFingerprint: 'working-tree-fingerprint',
    traceDeckVersion: '0.1.0-test',
    extraInventory: side === 'baseline'
      ? [{
          relativePath: 'vendor/linked-module',
          entryKind: 'submodule',
          reason: 'The committed submodule was not materialized.',
        }]
      : [],
  });
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe('extractReviewSnapshot', () => {
  it('normalizes completed datastore evidence without absolute paths or row identity', () => {
    const seeded = seedReview();
    const snapshot = extract(seeded);

    expect(snapshot.inventory).toContainEqual(expect.objectContaining({
      relativePath: 'src/configured.ts',
      analysisStatus: 'eligible',
      contentHash: 'inventory-src/configured.ts',
    }));
    expect(snapshot.inventory).toContainEqual(expect.objectContaining({
      relativePath: 'vendor/linked-module',
      entryKind: 'submodule',
      analysisStatus: 'inventory-only',
    }));
    expect(snapshot.graphFiles.some((file) => file.relativePath === 'vendor/linked-module')).toBe(false);
    expect(snapshot.graphFiles).toContainEqual(expect.objectContaining({
      relativePath: 'src/inferred-root.ts',
      language: 'typescript',
      isEntryPoint: true,
    }));

    expect(snapshot.edges).toContainEqual({
      fromPath: 'src/configured.ts',
      toPath: 'src/origin.ts',
      edgeType: 'import',
      typeOnly: false,
      sourceLines: [5, 7],
      specifiers: ['./origin', './origin.js'],
    });
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      fromPath: 'src/configured.ts',
      toPath: 'src/origin.ts',
      edgeType: 'import',
      typeOnly: true,
      sourceLines: [9],
    }));
    expect(snapshot.edges).toHaveLength(5);
    expect(snapshot.edges.some((edge) => edge.toPath.includes('unresolved'))).toBe(false);
    expect(snapshot.edges.some((edge) => edge.edgeType === ('reference' as EdgeType))).toBe(false);

    expect(snapshot.findings).toContainEqual(expect.objectContaining({
      findingType: 'syntax-error',
      fingerprint: 'syntax-fingerprint',
      dismissed: true,
    }));
    expect(snapshot.findings.some((finding) => finding.findingType === 'type-error')).toBe(false);
    expect(snapshot.findings.some((finding) => finding.findingType === 'architecture-violation')).toBe(false);
    expect(snapshot.architectureViolations).toHaveLength(1);
    expect(snapshot.architectureViolations[0]).toMatchObject({
      ruleId: seeded.ruleId,
      sourcePath: 'src/configured.ts',
      targetPath: 'src/origin.ts',
      severity: 'high',
      line: 7,
    });
    expect(snapshot.architectureViolations[0]?.ruleFingerprint).toBe(canonicalSha256({
      name: 'Configured cannot import origin',
      ruleType: 'forbid-import',
      sourcePattern: 'src/configured.ts',
      targetPattern: 'src/origin.ts',
      severity: 'high',
      exceptions: ['src/a.ts', 'src/z.ts'],
    }));

    expect(snapshot.cycles).toEqual([{
      memberPaths: ['src/cycle-a.ts', 'src/cycle-b.ts'],
      cyclePath: ['src/cycle-a.ts', 'src/cycle-b.ts', 'src/cycle-a.ts'],
    }]);
    expect(snapshot.reachableExports).toEqual([
      expect.objectContaining({ entryPoint: 'src/configured.ts', exportedName: 'configured' }),
      expect.objectContaining({
        entryPoint: 'src/index.ts',
        exportedName: 'publicValue',
        symbolKind: 'interface',
        originPath: 'src/origin.ts',
        line: 12,
      }),
    ]);
    expect(snapshot.reachableExports.some((record) => record.exportedName === 'hidden')).toBe(false);
    expect(snapshot.reachableExports.some((record) => record.exportedName === 'pythonValue')).toBe(false);

    expect(snapshot.limitations).toContainEqual(expect.objectContaining({
      scope: 'baseline',
      code: 'SCAN_LIMITATION',
      paths: ['src/configured.ts'],
    }));
    expect(snapshot.limitations).toContainEqual(expect.objectContaining({
      scope: 'baseline',
      code: 'UNSUPPORTED_EXPORT_SURFACE',
      paths: ['src/python.py'],
    }));
    expect(snapshot.limitations).toContainEqual(expect.objectContaining({
      scope: 'review',
      code: 'TYPE_ERROR_BASELINE_NOT_COMPARABLE',
      message: "Type errors were not compared because the isolated HEAD baseline does not reproduce the working tree's compiler dependency environment.",
    }));

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(FIXTURE_ROOT);
    expect(serialized).not.toContain(FIXTURE_ROOT.replace(/\\/g, '/'));
    expect(serialized).not.toContain('absolutePath');
    expect(serialized).not.toContain('modifiedAt');
    expect(serialized).not.toContain('createdAt');
  });

  it('sorts set-like evidence and fingerprints independently of repository insertion order', () => {
    const forward = extract(seedReview());
    const reversed = extract(seedReview({ reverse: true }));

    expect(reversed).toEqual(forward);
  });

  it('normalizes equivalent full and incremental scans identically apart from scan provenance', async () => {
    const store = new DataStore(openDatabase({ filePath: ':memory:' }));
    stores.push(store);
    const project = store.projects.createOrTouch('snapshot-parity', FIXTURE_ROOT);

    await runScan(store, { project, fullRescan: true });
    const full = extractReviewSnapshot({
      store,
      project,
      side: 'target',
      baseCommit: 'c'.repeat(40),
      baseTreeId: 'd'.repeat(40),
      workingTreeFingerprint: 'same-working-tree',
      traceDeckVersion: '0.1.0-test',
      extraInventory: [],
    });

    await runScan(store, { project, fullRescan: false });
    const incremental = extractReviewSnapshot({
      store,
      project,
      side: 'target',
      baseCommit: 'c'.repeat(40),
      baseTreeId: 'd'.repeat(40),
      workingTreeFingerprint: 'same-working-tree',
      traceDeckVersion: '0.1.0-test',
      extraInventory: [],
    });

    expect({ ...incremental, scanId: full.scanId }).toEqual(full);
  });
});
