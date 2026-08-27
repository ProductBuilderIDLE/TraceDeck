import { describe, expect, it } from 'vitest';
import {
  evaluateArchitectureRules,
  type ImportFact,
} from '@main/analysis/algorithms/architectureRules';
import type { ArchitectureRule } from '@shared/types';

function rule(overrides: Partial<ArchitectureRule> = {}): ArchitectureRule {
  return {
    id: 1,
    projectId: 1,
    name: 'Components must not import the database layer',
    enabled: true,
    ruleType: 'forbid-import',
    sourcePattern: 'src/components/**',
    targetPattern: 'src/db/**',
    configuration: { severity: 'high', exceptions: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fact(overrides: Partial<ImportFact> = {}): ImportFact {
  return {
    fromPath: 'src/components/Button.tsx',
    toPath: 'src/db/client.ts',
    specifier: '@app/db/client',
    line: 1,
    ...overrides,
  };
}

describe('evaluateArchitectureRules', () => {
  it('reports an import that crosses a forbidden boundary', () => {
    const { violations } = evaluateArchitectureRules([rule()], [fact()]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: 1,
      sourcePath: 'src/components/Button.tsx',
      targetPath: 'src/db/client.ts',
      severity: 'high',
      line: 1,
    });
  });

  it('allows an import that does not match the target pattern', () => {
    const { violations } = evaluateArchitectureRules(
      [rule()],
      [fact({ toPath: 'src/services/math.ts' })],
    );

    expect(violations).toEqual([]);
  });

  it('allows an import from a file outside the source pattern', () => {
    const { violations } = evaluateArchitectureRules(
      [rule()],
      [fact({ fromPath: 'src/server/handler.ts' })],
    );

    expect(violations).toEqual([]);
  });

  it('skips disabled rules', () => {
    const { violations } = evaluateArchitectureRules([rule({ enabled: false })], [fact()]);

    expect(violations).toEqual([]);
  });

  it('honours an exception pattern', () => {
    const { violations } = evaluateArchitectureRules(
      [rule({ configuration: { severity: 'high', exceptions: ['src/components/admin/**'] } })],
      [fact({ fromPath: 'src/components/admin/Panel.tsx' })],
    );

    expect(violations).toEqual([]);
  });

  it('ignores unresolved imports rather than guessing a violation', () => {
    const { violations } = evaluateArchitectureRules([rule()], [fact({ toPath: null })]);

    expect(violations).toEqual([]);
  });

  it('does not flag a file importing itself', () => {
    const { violations } = evaluateArchitectureRules(
      [rule({ sourcePattern: 'src/**', targetPattern: 'src/**' })],
      [fact({ fromPath: 'src/a.ts', toPath: 'src/a.ts' })],
    );

    expect(violations).toEqual([]);
  });

  it('evaluates several rules against the same import', () => {
    const { violations } = evaluateArchitectureRules(
      [
        rule({ id: 1, name: 'A' }),
        rule({ id: 2, name: 'B', targetPattern: 'src/**' }),
      ],
      [fact()],
    );

    expect(violations.map((v) => v.ruleId).sort()).toEqual([1, 2]);
  });

  it('reports a rule with an invalid pattern instead of failing the scan', () => {
    const { violations, invalidRules } = evaluateArchitectureRules(
      [rule({ sourcePattern: 'src/{unclosed' })],
      [fact()],
    );

    expect(violations).toEqual([]);
    expect(invalidRules).toEqual([
      { ruleId: 1, ruleName: expect.any(String), error: expect.stringMatching(/unmatched/) },
    ]);
  });

  it('normalises Windows separators before matching', () => {
    const { violations } = evaluateArchitectureRules(
      [rule()],
      [fact({ fromPath: 'src\\components\\Button.tsx', toPath: 'src\\db\\client.ts' })],
    );

    expect(violations).toHaveLength(1);
  });

  it('returns violations in a stable order', () => {
    const facts = [
      fact({ fromPath: 'src/components/Z.tsx', line: 3 }),
      fact({ fromPath: 'src/components/A.tsx', line: 9 }),
      fact({ fromPath: 'src/components/A.tsx', line: 1 }),
    ];

    const { violations } = evaluateArchitectureRules([rule()], facts);

    expect(violations.map((v) => `${v.sourcePath}:${v.line}`)).toEqual([
      'src/components/A.tsx:1',
      'src/components/A.tsx:9',
      'src/components/Z.tsx:3',
    ]);
  });
});
