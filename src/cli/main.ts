import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROJECT_CONFIGURATION } from '@shared/types';
import { createDataStore } from '@main/db';
import { runScan } from '@main/analysis/scanner';
import { createChangeReviewCoordinator } from '@main/services/changeReview/coordinator';
import { renderChangeReview } from '@main/services/changeReview/report';
import { ProjectOperationRegistry } from '@main/services/projectOperations';
import packageMetadata from '../../package.json';
import { parseCliOptions, renderCliHelp } from './options';

export interface CliIo {
  cwd: string;
  stdout(message: string): void;
  now(): string;
}

const PROCESS_IO: CliIo = {
  cwd: process.cwd(),
  stdout: (message) => process.stdout.write(message),
  now: () => new Date().toISOString(),
};

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

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const options = parseCliOptions(argv, io.cwd);
  if (options.help) {
    io.stdout(`${renderCliHelp()}\n`);
    return 0;
  }

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

    if (options.review) {
      const coordinator = createChangeReviewCoordinator(
        store,
        new ProjectOperationRegistry(),
        packageMetadata.version,
      );
      const record = await coordinator.runNow(project.id, options.reviewDepth);
      if (!record.compatible || !record.result) {
        throw new Error('The completed change review is incompatible.');
      }
      const status = await coordinator.status(project.id);
      const latest = status.latestReview?.reviewId === record.id ? status.latestReview : null;
      if (latest?.freshness === 'incompatible') {
        throw new Error('The completed change review is incompatible.');
      }
      const rendered = renderChangeReview(record.result, {
        freshness: latest?.freshness ?? 'stale',
        staleReasons: latest?.staleReasons ?? ['REVIEW_NOT_CURRENT'],
        generatedAt: io.now(),
      }, options.reviewFormat);
      if (options.reviewOutput) writeFileSync(options.reviewOutput, rendered, 'utf8');
      else io.stdout(rendered);
      return 0;
    }

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
      io.stdout(`${JSON.stringify({ scan, findings: novel }, null, 2)}\n`);
    } else if (options.format === 'sarif') {
      io.stdout(`${toSarif(novel)}\n`);
    } else {
      io.stdout(
        `Scan ${scan.status}: ${findings.length} finding(s), ${novel.length} new versus baseline.\n`,
      );
      for (const finding of novel.slice(0, 50)) {
        io.stdout(`- [${finding.findingType}] ${finding.title}\n`);
      }
    }

    return failing.length > 0 ? 1 : 0;
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2), PROCESS_IO);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'TraceDeck failed.'}\n`);
    process.exitCode = 1;
  }
}

void main();
