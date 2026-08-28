import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ALL_FINDING_TYPES, DEFAULT_PROJECT_CONFIGURATION, type FindingType } from '@shared/types';
import { createDataStore } from '@main/db';
import { runScan } from '@main/analysis/scanner';

interface CliOptions {
  root: string;
  fullRescan: boolean;
  failOn: FindingType[];
  format: 'text' | 'json' | 'sarif';
  baseline: string | null;
  writeBaseline: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const failOn: FindingType[] = [];
  let root = process.cwd();
  let fullRescan = false;
  let format: CliOptions['format'] = 'text';
  let baseline: string | null = null;
  let writeBaseline = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--fail-on') {
      const value = argv[index + 1] ?? '';
      index += 1;
      for (const raw of value.split(',').map((part) => part.trim()).filter(Boolean)) {
        if ((ALL_FINDING_TYPES as readonly string[]).includes(raw)) failOn.push(raw as FindingType);
      }
    } else if (arg === '--format') {
      const value = argv[index + 1] ?? 'text';
      index += 1;
      if (value === 'json' || value === 'sarif' || value === 'text') format = value;
    } else if (arg === '--full') {
      fullRescan = true;
    } else if (arg === '--baseline') {
      baseline = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--write-baseline') {
      writeBaseline = true;
    } else if (!arg.startsWith('-')) {
      root = resolve(arg);
    }
  }

  return { root, fullRescan, failOn, format, baseline, writeBaseline };
}

function toSarif(findings: Array<{ title: string; description: string; findingType: string }>): string {
  return JSON.stringify(
    {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'TraceDeck' } },
          results: findings.map((finding) => ({
            ruleId: finding.findingType,
            level: 'warning',
            message: { text: `${finding.title}. ${finding.description}` },
          })),
        },
      ],
    },
    null,
    2,
  );
}

function readBaseline(path: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { fingerprints?: string[] };
    return new Set(raw.fingerprints ?? []);
  } catch {
    return new Set();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cacheDir = join(options.root, '.tracedeck');
  mkdirSync(cacheDir, { recursive: true });
  const store = createDataStore(join(cacheDir, 'cli.sqlite'));

  try {
    const project = store.projects.createOrTouch(
      options.root.split(/[\\/]/).pop() || 'project',
      options.root,
    );
    store.projects.updateConfiguration(project.id, {
      ...DEFAULT_PROJECT_CONFIGURATION,
      ...project.configuration,
    });

    const scan = await runScan(store, {
      project: store.projects.findById(project.id) ?? project,
      fullRescan: options.fullRescan,
    });

    const findings = store.findings.list(project.id, { includeDismissed: false });
    const fingerprints = findings.map((finding) => finding.fingerprint);
    const baselineSet = options.baseline ? readBaseline(options.baseline) : new Set<string>();

    if (options.writeBaseline) {
      const target = options.baseline ?? join(options.root, '.tracedeck-baseline.json');
      writeFileSync(target, `${JSON.stringify({ fingerprints }, null, 2)}\n`);
    }

    const novel = options.baseline
      ? findings.filter((finding) => !baselineSet.has(finding.fingerprint))
      : findings;
    const failing = options.failOn.length
      ? novel.filter((finding) => options.failOn.includes(finding.findingType))
      : [];

    if (options.format === 'json') {
      process.stdout.write(`${JSON.stringify({ scan, findings: novel }, null, 2)}\n`);
    } else if (options.format === 'sarif') {
      process.stdout.write(`${toSarif(novel)}\n`);
    } else {
      process.stdout.write(
        `Scan ${scan.status}: ${findings.length} finding(s), ${novel.length} new versus baseline.\n`,
      );
      for (const finding of novel.slice(0, 50)) {
        process.stdout.write(`- [${finding.findingType}] ${finding.title}\n`);
      }
    }

    if (failing.length > 0) process.exitCode = 1;
  } finally {
    store.close();
  }
}

void main();
