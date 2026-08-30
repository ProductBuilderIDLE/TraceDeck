import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliOptions, renderCliHelp } from '../../../src/cli/options';

const CWD = resolve('C:/workspace');

describe('parseCliOptions', () => {
  it('preserves all existing valid scan flags and defaults', () => {
    expect(parseCliOptions([], CWD)).toEqual({
      root: CWD,
      fullRescan: false,
      failOn: [],
      format: 'text',
      baseline: null,
      writeBaseline: false,
      help: false,
      review: false,
      reviewFormat: 'text',
      reviewOutput: null,
      reviewDepth: 5,
    });

    expect(parseCliOptions([
      'repository folder',
      '--full',
      '--fail-on',
      'type-error, unused-export-candidate',
      '--format',
      'sarif',
      '--baseline',
      'baseline file.json',
      '--write-baseline',
    ], CWD)).toMatchObject({
      root: resolve(CWD, 'repository folder'),
      fullRescan: true,
      failOn: ['type-error', 'unused-export-candidate'],
      format: 'sarif',
      baseline: 'baseline file.json',
      writeBaseline: true,
      review: false,
    });
  });

  it('parses help without changing defaults', () => {
    expect(parseCliOptions(['--help'], CWD)).toMatchObject({ help: true, root: CWD });
  });

  it('uses cautious review defaults', () => {
    expect(parseCliOptions(['--review'], CWD)).toMatchObject({
      review: true,
      reviewFormat: 'text',
      reviewOutput: null,
      reviewDepth: 5,
      format: 'text',
      failOn: [],
    });
  });

  it.each(['text', 'json', 'markdown', 'html'] as const)(
    'parses the %s review format with an output path',
    (format) => {
      const options = parseCliOptions([
        '--review-output',
        'reports/review output.out',
        '--review-format',
        format,
        '--review',
      ], CWD);
      expect(options.reviewFormat).toBe(format);
      expect(options.reviewOutput).toBe(resolve(CWD, 'reports/review output.out'));
    },
  );

  it('accepts only review depths from 1 through 25', () => {
    expect(parseCliOptions(['--review', '--review-depth', '1'], CWD).reviewDepth).toBe(1);
    expect(parseCliOptions(['--review-depth', '25', '--review'], CWD).reviewDepth).toBe(25);
    for (const value of ['0', '26', '1.5', 'depth']) {
      expect(() => parseCliOptions(['--review', '--review-depth', value], CWD)).toThrow(
        /review-depth/i,
      );
    }
  });

  it('rejects invalid values and missing operands instead of silently ignoring them', () => {
    const invalidArguments = [
      ['--format', 'yaml'],
      ['--review', '--review-format', 'sarif'],
      ['--review', '--review-depth', 'nan'],
      ['--fail-on', 'not-a-finding'],
      ['--unknown'],
      ['--format'],
      ['--fail-on'],
      ['--baseline'],
      ['--review', '--review-format'],
      ['--review', '--review-output'],
      ['--review', '--review-depth'],
    ];
    for (const argv of invalidArguments) {
      expect(() => parseCliOptions(argv, CWD), argv.join(' ')).toThrow();
    }
  });

  it('requires an output path for HTML review reports', () => {
    expect(() => parseCliOptions(['--review', '--review-format', 'html'], CWD)).toThrow(
      /review-output/i,
    );
  });

  it.each([
    ['--fail-on', 'type-error'],
    ['--baseline', 'baseline.json'],
    ['--write-baseline'],
    ['--format', 'text'],
  ])('rejects explicit normal scan policy flags in review mode: %s', (...policyArgs) => {
    expect(() => parseCliOptions(['--review', ...policyArgs], CWD)).toThrow(/review/i);
    expect(() => parseCliOptions([...policyArgs, '--review'], CWD)).toThrow(/review/i);
  });

  it('rejects review-only flags when review mode is absent', () => {
    expect(() => parseCliOptions(['--review-format', 'json'], CWD)).toThrow(/--review/i);
    expect(() => parseCliOptions(['--review-output', 'review.txt'], CWD)).toThrow(/--review/i);
    expect(() => parseCliOptions(['--review-depth', '9'], CWD)).toThrow(/--review/i);
  });

  it('preserves paths containing spaces', () => {
    const options = parseCliOptions([
      'project with spaces',
      '--review',
      '--review-output',
      'output folder/change review.md',
      '--review-format',
      'markdown',
    ], CWD);
    expect(options.root).toBe(resolve(CWD, 'project with spaces'));
    expect(options.reviewOutput).toBe(resolve(CWD, 'output folder/change review.md'));
  });

  it('is independent of argument order for valid combinations', () => {
    const first = parseCliOptions([
      'project', '--review', '--review-depth', '7', '--review-output', 'review.json',
      '--review-format', 'json', '--full',
    ], CWD);
    const second = parseCliOptions([
      '--full', '--review-format', 'json', '--review-output', 'review.json',
      '--review-depth', '7', '--review', 'project',
    ], CWD);
    expect(first).toEqual(second);
  });
});

describe('renderCliHelp', () => {
  it('renders deterministic usage with every normal and review flag', () => {
    const first = renderCliHelp();
    expect(renderCliHelp()).toBe(first);
    expect(first).toContain('Usage:');
    for (const flag of [
      '--help',
      '--full',
      '--fail-on',
      '--format',
      '--baseline',
      '--write-baseline',
      '--review',
      '--review-format',
      '--review-output',
      '--review-depth',
    ]) {
      expect(first).toContain(flag);
    }
    expect(first).toContain('text|json|sarif');
    expect(first).toContain('text|json|markdown|html');
  });
});
