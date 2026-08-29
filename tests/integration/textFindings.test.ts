import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataStore } from '@main/db';
import { openDatabase } from '@main/db/connection';
import { runScan } from '@main/analysis/scanner';
import type { Project } from '@shared/types';

let store: DataStore;
let project: Project;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'tracedeck-text-'));
  await fs.writeFile(join(root, 'package.json'), '{ "name": "text-fixture" }\n');
  store = new DataStore(openDatabase({ filePath: ':memory:' }));
  project = store.projects.createOrTouch('text-fixture', root);
});

afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

function findings(type: 'merge-conflict' | 'syntax-error') {
  return store.findings.list(project.id, { findingType: type });
}

describe('merge conflict findings', () => {
  it('reports a conflict left in a non-source file', async () => {
    await fs.writeFile(
      join(root, 'style.css'),
      ['body {', '<<<<<<< HEAD', '  color: red;', '=======', '  color: blue;', '>>>>>>> other', '}'].join('\n'),
    );

    await runScan(store, { project, fullRescan: true });

    const found = findings('merge-conflict');
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toContain('style.css');
  });

  it('keeps reporting the conflict on an incremental rescan', async () => {
    await fs.writeFile(
      join(root, 'a.ts'),
      ['<<<<<<< HEAD', 'const a = 1;', '=======', 'const a = 2;', '>>>>>>> other'].join('\n'),
    );

    await runScan(store, { project, fullRescan: true });
    expect(findings('merge-conflict')).toHaveLength(1);

    await runScan(store, { project, fullRescan: false });
    expect(findings('merge-conflict')).toHaveLength(1);
  });

  it('clears the finding once the conflict is resolved', async () => {
    const file = join(root, 'a.ts');
    await fs.writeFile(
      file,
      ['<<<<<<< HEAD', 'const a = 1;', '=======', 'const a = 2;', '>>>>>>> other'].join('\n'),
    );
    await runScan(store, { project, fullRescan: true });
    expect(findings('merge-conflict')).toHaveLength(1);

    await fs.writeFile(file, 'const a = 1;\n');
    await runScan(store, { project, fullRescan: false });

    expect(findings('merge-conflict')).toEqual([]);
  });

  it('does not report documentation that discusses conflict markers', async () => {
    await fs.writeFile(
      join(root, 'README.md'),
      'Git writes <<<<<<< and ======= and >>>>>>> when a merge fails.\n',
    );

    await runScan(store, { project, fullRescan: true });

    expect(findings('merge-conflict')).toEqual([]);
  });
});

describe('JSON syntax findings', () => {
  it('reports invalid JSON in a file the dependency graph never parses', async () => {
    await fs.writeFile(join(root, 'settings.json'), '{ "a": 1,, }');

    await runScan(store, { project, fullRescan: true });

    const found = findings('syntax-error');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.title).toContain('settings.json');
  });

  it('reports a trailing comma, which the JSONC-tolerant parser alone would accept', async () => {
    await fs.writeFile(join(root, 'strict.json'), '{\n  "a": 1,\n}');

    await runScan(store, { project, fullRescan: true });

    expect(findings('syntax-error').length).toBeGreaterThan(0);
  });

  it('accepts valid JSON', async () => {
    await fs.writeFile(join(root, 'ok.json'), '{ "a": [1, 2, 3] }');

    await runScan(store, { project, fullRescan: true });

    expect(findings('syntax-error')).toEqual([]);
  });

  it('keeps a dismissed finding dismissed across a rescan', async () => {
    await fs.writeFile(join(root, 'bad.json'), '{ "a": 1,, }');
    await runScan(store, { project, fullRescan: true });

    const first = findings('syntax-error')[0];
    expect(first).toBeDefined();
    store.findings.setDismissed(first!.id, true);

    await runScan(store, { project, fullRescan: true });

    const after = store.findings.list(project.id, {
      findingType: 'syntax-error',
      includeDismissed: true,
    });
    expect(after[0]?.dismissedAt).not.toBeNull();
  });
});
