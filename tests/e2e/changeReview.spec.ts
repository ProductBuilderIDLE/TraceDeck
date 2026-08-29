import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { test, expect, type TestInfo } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { openDatabase, closeDatabase } from '../../src/main/db/connection';

const execFileAsync = promisify(execFile);

interface ReviewFixture {
  root: string;
  repo: string;
  userData: string;
  dbPath: string;
  exportPath: string;
  gitStatusBytes(): Promise<string>;
}

async function createElectronReviewFixture(outputPath: string): Promise<ReviewFixture> {
  const root = outputPath;
  const repo = join(root, 'repo');
  const userData = join(root, 'user-data');
  const exportPath = join(root, 'exports', 'review.md');
  const dbPath = join(userData, 'tracedeck.db');

  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(join(root, 'exports'), { recursive: true });

  const packageJson = JSON.stringify({ name: 'test-repo', type: 'module', version: '1.0.0' }, null, 2);
  await fs.writeFile(join(repo, 'package.json'), packageJson);
  await fs.writeFile(
    join(repo, 'index.js'),
    [
      "import { helper } from './helper.js';",
      'export function main() {',
      '  return helper();',
      '}',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    join(repo, 'helper.js'),
    [
      "export function helper() {",
      "  return 'baseline';",
      '}',
      '',
    ].join('\n'),
  );

  await execFileAsync('git', ['init', repo]);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await execFileAsync('git', ['-C', repo, 'add', '.']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'Initial']);

  await fs.writeFile(
    join(repo, 'helper.js'),
    [
      "export function helper() {",
      "  return 'changed';",
      '}',
      '',
    ].join('\n'),
  );

  const db = openDatabase({ filePath: dbPath });
  const timestamp = new Date().toISOString();
  const configuration = JSON.stringify({
    excludePatterns: [],
    entryPoints: [],
    respectGitignore: true,
    includeTestFiles: true,
    typeCheck: false,
    unusedExportExclusions: [],
  });

  db.prepare(
    `INSERT INTO projects (name, root_path, created_at, last_opened_at, configuration_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('test-repo', repo, timestamp, timestamp, configuration);
  closeDatabase(db);

  return {
    root,
    repo,
    userData,
    dbPath,
    exportPath,
    gitStatusBytes: async () => {
      const { stdout } = await execFileAsync('git', ['-C', repo, 'status', '--porcelain=v1']);
      return stdout;
    },
  };
}

test('reviews the working tree without changing Git state', async ({ page: _page }, testInfo: TestInfo) => {
  const fixture = await createElectronReviewFixture(testInfo.outputPath('fixture'));
  const before = await fixture.gitStatusBytes();

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'),
  );

  const electronApp = await electron.launch({
    args: [resolve('out/main/index.js'), `--user-data-dir=${fixture.userData}`],
    env,
    dumpio: true,
  });

  try {
    const page = await electronApp.firstWindow();
    page.on('console', (msg) => console.log('[renderer console]', msg.text()));
    page.on('pageerror', (error) => console.log('[renderer error]', error.message));
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: /test-repo/ }).waitFor();

    await page.getByRole('button', { name: 'Scan', exact: true }).click();
    await page.getByRole('button', { name: 'Scan', exact: true }).waitFor({ state: 'visible', timeout: 60_000 });

    await page.getByRole('button', { name: 'Change review', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Run review' })).toBeVisible();
    const liveRegion = page.locator('[aria-label="Change review workspace"] [aria-live="polite"]');

    await page.getByRole('button', { name: 'Run review' }).click();
    await expect(liveRegion).toContainText(/: /, { timeout: 30_000 });
    await expect(page.getByText('The latest review is current.')).toBeVisible({ timeout: 100_000 });

    const after = await fixture.gitStatusBytes();
    expect(after).toBe(before);

    await page.getByRole('tab', { name: 'Possible impact' }).click();
    const affectedRow = page.locator('li', { hasText: /index\.js/ }).first();
    await expect(affectedRow).toContainText('Affected');
    await affectedRow.getByRole('button', { name: 'Graph' }).click();

    await expect(page.getByText(/Review evidence ·/)).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText(/Review evidence ·/)).not.toBeVisible();

    await page.getByRole('button', { name: 'Change review', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Export review' })).toBeVisible();

    await electronApp.evaluate(
      ({ dialog }, filePath: string) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      },
      fixture.exportPath,
    );

    await page.getByRole('button', { name: 'Export review' }).click();
    await expect(page.getByText('Exported to review.md')).toBeVisible();

    await fs.writeFile(
      join(fixture.repo, 'helper.js'),
      [
        "export function helper() {",
        "  return 'stale';",
        '}',
        '',
      ].join('\n'),
    );

    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await expect(page.getByText(/The latest review is stale/i)).toBeVisible();

    await page.getByRole('button', { name: 'Change review', exact: true }).click();
    await expect(page.getByText('This review is stale.')).toBeVisible();
    await expect(page.getByText('WORKING_TREE_CHANGED')).toBeVisible();
  } finally {
    await electronApp.close();
  }
});
