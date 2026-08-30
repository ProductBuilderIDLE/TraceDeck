/**
 * Captures a set of application screenshots for documentation and the website.
 *
 * The app is launched exactly as a user would see it, against a real project — this
 * repository itself — rather than a toy fixture, so the graph, findings, and metrics show
 * realistic shapes rather than three files and one edge.
 *
 * Opening a project normally goes through a native folder dialog, which cannot be driven
 * from automation. Instead the project row is written directly into a throwaway user-data
 * database and Electron is pointed at it, which is the same state the dialog would have
 * produced. Nothing is written to the repository being scanned.
 *
 * Run with:  npx vite-node --config vitest.config.ts scripts/screenshots.ts
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { openDatabase, closeDatabase } from '../src/main/db/connection';

const OUTPUT_DIR = resolve('screenshots');
const PROJECT_ROOT = resolve('.');
const WIDTH = 1600;
const HEIGHT = 1000;

/** Generous: a full scan of this repository with tree-sitter grammars is not instant. */
const SCAN_TIMEOUT_MS = 240_000;

/** While iterating on the graph itself, skip the other views. */
const GRAPH_ONLY = process.env['SHOTS_GRAPH_ONLY'] === '1';

function seedUserData(): string {
  const userData = mkdtempSync(join(tmpdir(), 'tracedeck-shots-'));
  const db = openDatabase({ filePath: join(userData, 'tracedeck.db') });
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO projects (name, root_path, created_at, last_opened_at, configuration_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'TraceDeck',
    PROJECT_ROOT,
    now,
    now,
    JSON.stringify({
      excludePatterns: [],
      entryPoints: [],
      respectGitignore: true,
      includeTestFiles: true,
      typeCheck: false,
      unusedExportExclusions: [],
    }),
  );

  closeDatabase(db);
  return userData;
}

async function shoot(page: Page, name: string): Promise<void> {
  // Let layout and any canvas repaint settle before the frame is grabbed.
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUTPUT_DIR, `${name}.png`) });
  process.stdout.write(`  captured ${name}.png\n`);
}

async function openView(page: Page, label: string): Promise<boolean> {
  const button = page.getByRole('button', { name: label, exact: true }).first();
  try {
    await button.waitFor({ state: 'visible', timeout: 5_000 });
    await button.click();
    return true;
  } catch {
    process.stdout.write(`  skipped "${label}" (not available)\n`);
    return false;
  }
}

/**
 * Finds a node by sweeping the pointer across the canvas until the hover card appears.
 *
 * The graph is drawn to a canvas, so its nodes are not addressable as DOM elements and
 * cannot be targeted by a selector. Sweeping is crude but reliable, and it exercises the
 * hover readout exactly the way a person would.
 */
async function hoverAnyNode(page: Page): Promise<boolean> {
  const card = page.locator('.pointer-events-none.absolute.z-20');
  const box = await page.locator('.relative.min-h-0.flex-1').first().boundingBox();
  if (!box) return false;

  for (let row = 1; row <= 6; row += 1) {
    for (let column = 1; column <= 10; column += 1) {
      await page.mouse.move(
        box.x + (box.width * column) / 11,
        box.y + (box.height * row) / 7,
      );
      await page.waitForTimeout(70);
      if (await card.isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const userData = seedUserData();

  // ELECTRON_RUN_AS_NODE is set by the tooling that launches this script; leaving it in the
  // child environment would start Electron as a plain Node process with no window at all.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'),
  ) as Record<string, string>;

  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      args: [resolve('out/main/index.js'), `--user-data-dir=${userData}`],
      env,
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
      },
      { width: WIDTH, height: HEIGHT },
    );
    await page.waitForTimeout(600);

    process.stdout.write('Scanning the project…\n');
    await page.getByRole('button', { name: 'Scan', exact: true }).click();
    await page
      .getByText('Last scanned', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: SCAN_TIMEOUT_MS });
    process.stdout.write('Scan complete.\n');

    await shoot(page, '01-dashboard');

    if (await openView(page, 'Dependency graph')) {
      // The layout runs once the payload arrives; give it room to finish and fit.
      await page.waitForTimeout(3_500);
      await shoot(page, '02-graph-layered');

      if (await hoverAnyNode(page)) {
        await shoot(page, '03-graph-hover-detail');
        await page.mouse.click(
          (await page.viewportSize())?.width ?? WIDTH / 2,
          10,
          { button: 'left' },
        ).catch(() => undefined);
      }
    }

    for (const [label, name] of GRAPH_ONLY ? [] : ([
      ['Explorer', '04-explorer'],
      ['Circular dependencies', '05-circular-dependencies'],
      ['Unused exports', '06-unused-exports'],
      ['Complexity', '07-complexity'],
      ['Metrics', '08-metrics'],
      ['Architecture rules', '09-architecture-rules'],
      ['Reports', '10-reports'],
      ['Settings', '11-settings'],
    ] as const)) {
      if (await openView(page, label)) await shoot(page, name);
    }
  } finally {
    await app?.close().catch(() => undefined);
  }

  process.stdout.write(`\nScreenshots written to ${OUTPUT_DIR}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
