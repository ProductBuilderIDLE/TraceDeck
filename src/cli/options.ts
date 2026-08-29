import { resolve } from 'node:path';
import type { ReviewExportFormat } from '@shared/changeReview';
import { DEFAULT_MAX_TRAVERSAL_DEPTH, MAX_TRAVERSAL_DEPTH } from '@shared/constants';
import { ALL_FINDING_TYPES, type FindingType } from '@shared/types';

export interface CliOptions {
  root: string;
  fullRescan: boolean;
  failOn: FindingType[];
  format: 'text' | 'json' | 'sarif';
  baseline: string | null;
  writeBaseline: boolean;
  help: boolean;
  review: boolean;
  reviewFormat: ReviewExportFormat;
  reviewOutput: string | null;
  reviewDepth: number;
}

const SCAN_FORMATS = ['text', 'json', 'sarif'] as const;
const REVIEW_FORMATS = ['text', 'json', 'markdown', 'html'] as const;

function operand(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function oneOf<T extends string>(value: string, option: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${option} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function findingTypes(value: string): FindingType[] {
  const rawTypes = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (rawTypes.length === 0) throw new Error('--fail-on requires at least one finding type.');
  return rawTypes.map((raw) => oneOf(raw, '--fail-on', ALL_FINDING_TYPES));
}

function reviewDepth(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TRAVERSAL_DEPTH) {
    throw new Error(`--review-depth must be an integer from 1 through ${MAX_TRAVERSAL_DEPTH}.`);
  }
  return parsed;
}

/** Parses CLI arguments without reading process state or touching the filesystem. */
export function parseCliOptions(argv: readonly string[], cwd: string): CliOptions {
  const failOn: FindingType[] = [];
  let root = resolve(cwd);
  let fullRescan = false;
  let format: CliOptions['format'] = 'text';
  let baseline: string | null = null;
  let writeBaseline = false;
  let help = false;
  let review = false;
  let selectedReviewFormat: ReviewExportFormat = 'text';
  let reviewOutput: string | null = null;
  let selectedReviewDepth = DEFAULT_MAX_TRAVERSAL_DEPTH;
  const explicitScanPolicy = new Set<string>();
  const explicitReviewOptions = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--full':
        fullRescan = true;
        break;
      case '--fail-on': {
        const value = operand(argv, index, arg);
        failOn.push(...findingTypes(value));
        explicitScanPolicy.add(arg);
        index += 1;
        break;
      }
      case '--format': {
        const value = operand(argv, index, arg);
        format = oneOf(value, arg, SCAN_FORMATS);
        explicitScanPolicy.add(arg);
        index += 1;
        break;
      }
      case '--baseline':
        baseline = operand(argv, index, arg);
        explicitScanPolicy.add(arg);
        index += 1;
        break;
      case '--write-baseline':
        writeBaseline = true;
        explicitScanPolicy.add(arg);
        break;
      case '--review':
        review = true;
        break;
      case '--review-format': {
        const value = operand(argv, index, arg);
        selectedReviewFormat = oneOf(value, arg, REVIEW_FORMATS);
        explicitReviewOptions.add(arg);
        index += 1;
        break;
      }
      case '--review-output':
        reviewOutput = resolve(cwd, operand(argv, index, arg));
        explicitReviewOptions.add(arg);
        index += 1;
        break;
      case '--review-depth':
        selectedReviewDepth = reviewDepth(operand(argv, index, arg));
        explicitReviewOptions.add(arg);
        index += 1;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        root = resolve(cwd, arg);
        break;
    }
  }

  if (review && explicitScanPolicy.size > 0) {
    throw new Error(
      `Review mode cannot be combined with normal scan policy option(s): ${[
        ...explicitScanPolicy,
      ].join(', ')}.`,
    );
  }
  if (!review && explicitReviewOptions.size > 0) {
    throw new Error(`${[...explicitReviewOptions].join(', ')} requires --review.`);
  }
  if (review && selectedReviewFormat === 'html' && reviewOutput === null) {
    throw new Error('HTML review reports require --review-output.');
  }

  return {
    root,
    fullRescan,
    failOn,
    format,
    baseline,
    writeBaseline,
    help,
    review,
    reviewFormat: selectedReviewFormat,
    reviewOutput,
    reviewDepth: selectedReviewDepth,
  };
}

export function renderCliHelp(): string {
  return [
    'Usage: tracedeck [root] [options]',
    '',
    'Normal scan options:',
    '  --full                         Force a full rescan.',
    '  --fail-on <types>              Fail on comma-separated finding types.',
    '  --format text|json|sarif       Select normal scan output (default: text).',
    '  --baseline <path>              Compare finding fingerprints with a baseline.',
    '  --write-baseline               Write fingerprints to the baseline path.',
    '',
    'Change review options:',
    '  --review                       Compare the working tree with HEAD.',
    '  --review-format text|json|markdown|html',
    '                                 Select review output (default: text).',
    '  --review-output <path>         Write the review report to a file.',
    `  --review-depth <1-${MAX_TRAVERSAL_DEPTH}>            Maximum possible-impact path depth (default: ${DEFAULT_MAX_TRAVERSAL_DEPTH}).`,
    '',
    'General:',
    '  --help, -h                     Show this help without scanning.',
    '',
    'HTML review reports require --review-output. Normal --format is separate from',
    '--review-format and cannot be combined with --review.',
  ].join('\n');
}
