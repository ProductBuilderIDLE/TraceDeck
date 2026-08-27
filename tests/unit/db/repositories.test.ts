import { beforeEach, describe, expect, it } from 'vitest';
import { DataStore } from '@main/db';
import { openDatabase } from '@main/db/connection';
import { fileNodeId, symbolNodeId } from '@shared/nodeIds';

function newStore(): DataStore {
  return new DataStore(openDatabase({ filePath: ':memory:' }));
}

function seedProject(store: DataStore) {
  const project = store.projects.createOrTouch('demo', '/tmp/demo');
  const scan = store.scans.start(project.id, 'abc1234');
  return { project, scan };
}

describe('ProjectRepository', () => {
  let store: DataStore;
  beforeEach(() => {
    store = newStore();
  });

  it('creates a project and reads it back', () => {
    const project = store.projects.createOrTouch('demo', '/tmp/demo');

    expect(project.id).toBeGreaterThan(0);
    expect(project.rootPath).toBe('/tmp/demo');
    expect(project.configuration.respectGitignore).toBe(true);
    expect(store.projects.findById(project.id)).toEqual(project);
  });

  it('reopens an existing root path instead of duplicating it', () => {
    const first = store.projects.createOrTouch('demo', '/tmp/demo');
    const second = store.projects.createOrTouch('renamed', '/tmp/demo');

    expect(second.id).toBe(first.id);
    expect(store.projects.list()).toHaveLength(1);
  });

  it('persists configuration changes', () => {
    const project = store.projects.createOrTouch('demo', '/tmp/demo');
    const updated = store.projects.updateConfiguration(project.id, {
      ...project.configuration,
      entryPoints: ['src/index.ts'],
      includeTestFiles: false,
    });

    expect(updated?.configuration.entryPoints).toEqual(['src/index.ts']);
    expect(updated?.configuration.includeTestFiles).toBe(false);
  });

  it('falls back to defaults when stored configuration is corrupt', () => {
    const project = store.projects.createOrTouch('demo', '/tmp/demo');
    store.db.prepare('UPDATE projects SET configuration_json = ? WHERE id = ?').run('{oops', project.id);

    expect(store.projects.findById(project.id)?.configuration.respectGitignore).toBe(true);
  });

  it('cascades deletes to scans, files, symbols, and edges', () => {
    const { project, scan } = seedProject(store);
    const ids = store.files.upsertMany([
      {
        projectId: project.id,
        relativePath: 'src/a.ts',
        absolutePath: '/tmp/demo/src/a.ts',
        extension: '.ts',
        contentHash: 'hash-a',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        isEntryPoint: false,
        scanId: scan.id,
      },
    ]);
    const fileId = ids.get('src/a.ts') as number;
    store.symbols.insertMany([
      {
        projectId: project.id,
        fileId,
        name: 'doThing',
        kind: 'function',
        isExported: true,
        isDefaultExport: false,
        startLine: 1,
        endLine: 3,
        metadata: {},
        scanId: scan.id,
      },
    ]);

    store.projects.remove(project.id);

    expect(store.files.countByProject(project.id)).toBe(0);
    expect(store.symbols.countByProject(project.id)).toBe(0);
    expect(store.scans.latestForProject(project.id)).toBeNull();
  });
});

describe('FileRepository', () => {
  let store: DataStore;
  beforeEach(() => {
    store = newStore();
  });

  it('upserts files and returns their ids by relative path', () => {
    const { project, scan } = seedProject(store);

    const ids = store.files.upsertMany([
      {
        projectId: project.id,
        relativePath: 'src/a.ts',
        absolutePath: '/tmp/demo/src/a.ts',
        extension: '.ts',
        contentHash: 'hash-a',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        isEntryPoint: true,
        scanId: scan.id,
      },
      {
        projectId: project.id,
        relativePath: 'src/b.ts',
        absolutePath: '/tmp/demo/src/b.ts',
        extension: '.ts',
        contentHash: 'hash-b',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        isEntryPoint: false,
        scanId: scan.id,
      },
    ]);

    expect(ids.size).toBe(2);
    expect(store.files.countByProject(project.id)).toBe(2);
    expect(store.files.findByPath(project.id, 'src/a.ts')?.isEntryPoint).toBe(true);
  });

  it('updates rather than duplicates a file scanned twice', () => {
    const { project, scan } = seedProject(store);
    const base = {
      projectId: project.id,
      relativePath: 'src/a.ts',
      absolutePath: '/tmp/demo/src/a.ts',
      extension: '.ts',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      isEntryPoint: false,
      scanId: scan.id,
    };

    const first = store.files.upsertMany([{ ...base, contentHash: 'hash-1' }]);
    const second = store.files.upsertMany([{ ...base, contentHash: 'hash-2' }]);

    expect(second.get('src/a.ts')).toBe(first.get('src/a.ts'));
    expect(store.files.countByProject(project.id)).toBe(1);
    expect(store.files.findByPath(project.id, 'src/a.ts')?.contentHash).toBe('hash-2');
  });

  it('exposes fingerprints for incremental rescan decisions', () => {
    const { project, scan } = seedProject(store);
    store.files.upsertMany([
      {
        projectId: project.id,
        relativePath: 'src/a.ts',
        absolutePath: '/tmp/demo/src/a.ts',
        extension: '.ts',
        contentHash: 'hash-a',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        isEntryPoint: false,
        scanId: scan.id,
      },
    ]);

    const fingerprints = store.files.fingerprints(project.id);

    expect(fingerprints.get('src/a.ts')?.contentHash).toBe('hash-a');
  });

  it('removes deleted files and their dependent rows', () => {
    const { project, scan } = seedProject(store);
    const ids = store.files.upsertMany([
      {
        projectId: project.id,
        relativePath: 'src/gone.ts',
        absolutePath: '/tmp/demo/src/gone.ts',
        extension: '.ts',
        contentHash: 'hash',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        isEntryPoint: false,
        scanId: scan.id,
      },
    ]);
    const fileId = ids.get('src/gone.ts') as number;
    store.symbols.insertMany([
      {
        projectId: project.id,
        fileId,
        name: 'x',
        kind: 'variable',
        isExported: true,
        isDefaultExport: false,
        startLine: 1,
        endLine: 1,
        metadata: {},
        scanId: scan.id,
      },
    ]);

    expect(store.files.removeByIds([fileId])).toBe(1);
    expect(store.symbols.countByProject(project.id)).toBe(0);
  });
});

describe('EdgeRepository', () => {
  let store: DataStore;
  beforeEach(() => {
    store = newStore();
  });

  function seedGraph() {
    const { project, scan } = seedProject(store);
    const ids = store.files.upsertMany(
      ['src/a.ts', 'src/b.ts'].map((relativePath) => ({
        projectId: project.id,
        relativePath,
        absolutePath: `/tmp/demo/${relativePath}`,
        extension: '.ts',
        contentHash: `hash-${relativePath}`,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        isEntryPoint: false,
        scanId: scan.id,
      })),
    );
    return { project, scan, ids };
  }

  it('stores edges and exposes them as an adjacency projection', () => {
    const { project, scan, ids } = seedGraph();

    store.edges.insertMany([
      {
        projectId: project.id,
        fromNodeType: 'file',
        fromNodeId: fileNodeId('src/a.ts'),
        toNodeType: 'file',
        toNodeId: fileNodeId('src/b.ts'),
        edgeType: 'import',
        sourceFileId: ids.get('src/a.ts') as number,
        sourceLine: 1,
        metadata: { specifier: './b' },
        scanId: scan.id,
      },
    ]);

    const adjacency = store.edges.adjacency(project.id);

    expect(adjacency).toEqual([
      {
        from: 'file:src/a.ts',
        to: 'file:src/b.ts',
        edgeType: 'import',
        unresolved: false,
        sourceLine: 1,
        specifier: './b',
      },
    ]);
  });

  it('counts unresolved edges separately from resolved ones', () => {
    const { project, scan, ids } = seedGraph();

    store.edges.insertMany([
      {
        projectId: project.id,
        fromNodeType: 'file',
        fromNodeId: fileNodeId('src/a.ts'),
        toNodeType: 'file',
        toNodeId: fileNodeId('src/b.ts'),
        edgeType: 'import',
        sourceFileId: ids.get('src/a.ts') as number,
        sourceLine: 1,
        metadata: { specifier: './b' },
        scanId: scan.id,
      },
      {
        projectId: project.id,
        fromNodeType: 'file',
        fromNodeId: fileNodeId('src/a.ts'),
        toNodeType: 'file',
        toNodeId: 'unresolved:some-package',
        edgeType: 'import',
        sourceFileId: ids.get('src/a.ts') as number,
        sourceLine: 2,
        metadata: { specifier: 'some-package', unresolved: true },
        scanId: scan.id,
      },
    ]);

    expect(store.edges.countByProject(project.id)).toBe(2);
    expect(store.edges.countUnresolved(project.id)).toBe(1);
  });

  it('rebuilds only the edges declared by files that changed', () => {
    const { project, scan, ids } = seedGraph();
    const aId = ids.get('src/a.ts') as number;
    const bId = ids.get('src/b.ts') as number;

    store.edges.insertMany([
      {
        projectId: project.id,
        fromNodeType: 'file',
        fromNodeId: fileNodeId('src/a.ts'),
        toNodeType: 'file',
        toNodeId: fileNodeId('src/b.ts'),
        edgeType: 'import',
        sourceFileId: aId,
        sourceLine: 1,
        metadata: {},
        scanId: scan.id,
      },
      {
        projectId: project.id,
        fromNodeType: 'file',
        fromNodeId: fileNodeId('src/b.ts'),
        toNodeType: 'symbol',
        toNodeId: symbolNodeId('src/b.ts', 'helper'),
        edgeType: 'export',
        sourceFileId: bId,
        sourceLine: 4,
        metadata: {},
        scanId: scan.id,
      },
    ]);

    store.edges.deleteBySourceFileIds([aId]);

    const remaining = store.edges.listByProject(project.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.sourceFileId).toBe(bId);
  });
});

describe('FindingRepository', () => {
  let store: DataStore;
  beforeEach(() => {
    store = newStore();
  });

  function insertCycleFinding(projectId: number, scanId: number, fingerprint: string) {
    store.findings.replaceForScan(projectId, scanId, ['circular-dependency'], [
      {
        projectId,
        scanId,
        findingType: 'circular-dependency',
        severity: 'medium',
        title: 'Cycle between a and b',
        description: 'Static analysis result.',
        relatedNodeIds: [fileNodeId('src/a.ts'), fileNodeId('src/b.ts')],
        details: { kind: 'cycle', cyclePath: ['src/a.ts', 'src/b.ts'], edges: [] },
        fingerprint,
      },
    ]);
  }

  it('replaces findings of a type without touching other types', () => {
    const { project, scan } = seedProject(store);

    insertCycleFinding(project.id, scan.id, 'cycle:a|b');
    store.findings.replaceForScan(project.id, scan.id, ['unresolved-import'], [
      {
        projectId: project.id,
        scanId: scan.id,
        findingType: 'unresolved-import',
        severity: 'info',
        title: 'Could not resolve "./missing"',
        description: 'Static analysis result.',
        relatedNodeIds: [],
        details: {
          kind: 'unresolved-import',
          filePath: 'src/a.ts',
          specifier: './missing',
          line: 2,
          reason: 'file-not-found',
        },
        fingerprint: 'unresolved:src/a.ts|./missing',
      },
    ]);

    expect(store.findings.countByType(project.id, 'circular-dependency')).toBe(1);
    expect(store.findings.countByType(project.id, 'unresolved-import')).toBe(1);
  });

  it('carries a dismissal across a rescan via the fingerprint', () => {
    const { project, scan } = seedProject(store);
    insertCycleFinding(project.id, scan.id, 'cycle:a|b');

    const finding = store.findings.list(project.id)[0];
    expect(finding).toBeDefined();
    expect(store.findings.setDismissed(finding!.id, true)).toBe(true);
    expect(store.findings.countByType(project.id, 'circular-dependency')).toBe(0);

    // A later scan re-detects the same cycle and must not resurface it.
    const rescan = store.scans.start(project.id, 'def5678');
    insertCycleFinding(project.id, rescan.id, 'cycle:a|b');

    expect(store.findings.countByType(project.id, 'circular-dependency')).toBe(0);
    expect(store.findings.list(project.id, { includeDismissed: true })).toHaveLength(1);
  });

  it('restores a finding when the dismissal is undone', () => {
    const { project, scan } = seedProject(store);
    insertCycleFinding(project.id, scan.id, 'cycle:a|b');
    const finding = store.findings.list(project.id)[0]!;

    store.findings.setDismissed(finding.id, true);
    store.findings.setDismissed(finding.id, false);

    expect(store.findings.countByType(project.id, 'circular-dependency')).toBe(1);
  });
});

describe('RuleRepository', () => {
  let store: DataStore;
  beforeEach(() => {
    store = newStore();
  });

  it('creates, updates, and deletes rules', () => {
    const project = store.projects.createOrTouch('demo', '/tmp/demo');

    const created = store.rules.upsert({
      projectId: project.id,
      name: 'UI must not reach the database',
      enabled: true,
      ruleType: 'forbid-import',
      sourcePattern: 'src/components/**',
      targetPattern: 'src/db/**',
      configuration: { severity: 'high', exceptions: [] },
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.configuration.severity).toBe('high');

    const updated = store.rules.upsert({
      id: created.id,
      projectId: project.id,
      name: created.name,
      enabled: false,
      ruleType: 'forbid-import',
      sourcePattern: created.sourcePattern,
      targetPattern: created.targetPattern,
      configuration: created.configuration,
    });

    expect(updated.enabled).toBe(false);
    expect(store.rules.listEnabled(project.id)).toHaveLength(0);
    expect(store.rules.remove(created.id)).toBe(true);
    expect(store.rules.listByProject(project.id)).toHaveLength(0);
  });
});

describe('ScanRepository', () => {
  let store: DataStore;
  beforeEach(() => {
    store = newStore();
  });

  it('records completion details and returns the latest completed scan', () => {
    const { project, scan } = seedProject(store);

    store.scans.complete(scan.id, {
      status: 'completed',
      totalFiles: 10,
      parsedFiles: 9,
      errorCount: 1,
      summary: null,
    });

    const latest = store.scans.latestCompletedForProject(project.id);
    expect(latest?.status).toBe('completed');
    expect(latest?.parsedFiles).toBe(9);
    expect(latest?.errorCount).toBe(1);
  });

  it('marks scans left running by a previous process as failed', () => {
    const { project } = seedProject(store);

    expect(store.scans.markInterruptedScansFailed()).toBe(1);
    expect(store.scans.latestForProject(project.id)?.status).toBe('failed');
  });

  it('prunes superseded scans and their rows', () => {
    const { project, scan } = seedProject(store);
    const newer = store.scans.start(project.id, 'newer');

    expect(store.scans.pruneOlderScans(project.id, newer.id)).toBe(1);
    expect(store.scans.findById(scan.id)).toBeNull();
    expect(store.scans.findById(newer.id)).not.toBeNull();
  });
});
