import { describe, expect, it } from 'vitest';
import { GraphIndex } from '@main/analysis/algorithms/graphIndex';
import { computeRiskScore, type RiskScoreInputs } from '@main/analysis/algorithms/riskScore';
import type { AdjacencyEdge } from '@main/db/repositories/edgeRepository';

function edge(from: string, to: string): AdjacencyEdge {
  return { from, to, edgeType: 'import', unresolved: false, sourceLine: 1, specifier: null };
}

function inputs(overrides: Partial<RiskScoreInputs> = {}): RiskScoreInputs {
  return {
    nodeId: 'file:src/core.ts',
    index: new GraphIndex([]),
    inCycle: false,
    reachableFromEntryPoint: false,
    unresolvedEdgeCount: 0,
    hasTestDependents: true,
    ...overrides,
  };
}

function factor(score: ReturnType<typeof computeRiskScore>, key: string) {
  return score.factors.find((f) => f.key === key);
}

describe('computeRiskScore', () => {
  it('scores an isolated, tested file at the floor', () => {
    const score = computeRiskScore(inputs());

    expect(score.score).toBe(0);
    expect(score.path).toBe('src/core.ts');
  });

  it('adds points for each direct dependent', () => {
    const index = new GraphIndex([
      edge('file:src/a.ts', 'file:src/core.ts'),
      edge('file:src/b.ts', 'file:src/core.ts'),
    ]);

    const score = computeRiskScore(inputs({ index }));

    expect(factor(score, 'direct-dependents')).toMatchObject({ rawValue: 2, points: 6 });
  });

  it('caps the direct-dependent contribution at its maximum', () => {
    const edges = Array.from({ length: 50 }, (_, i) => edge(`file:src/d${i}.ts`, 'file:src/core.ts'));
    const score = computeRiskScore(inputs({ index: new GraphIndex(edges) }));

    const direct = factor(score, 'direct-dependents');
    expect(direct?.points).toBe(direct?.maxPoints);
  });

  it('counts transitive dependents separately from direct ones', () => {
    const index = new GraphIndex([
      edge('file:src/mid.ts', 'file:src/core.ts'),
      edge('file:src/top.ts', 'file:src/mid.ts'),
    ]);

    const score = computeRiskScore(inputs({ index }));

    expect(factor(score, 'direct-dependents')?.rawValue).toBe(1);
    expect(factor(score, 'transitive-dependents')?.rawValue).toBe(1);
  });

  it('adds a fixed amount when the file is reachable from an entry point', () => {
    const withEntry = computeRiskScore(inputs({ reachableFromEntryPoint: true }));
    const without = computeRiskScore(inputs({ reachableFromEntryPoint: false }));

    expect(withEntry.score - without.score).toBe(15);
  });

  it('adds a fixed amount when the file is in a cycle', () => {
    const inCycle = computeRiskScore(inputs({ inCycle: true }));
    const acyclic = computeRiskScore(inputs({ inCycle: false }));

    expect(inCycle.score - acyclic.score).toBe(15);
  });

  it('adds points when imports could not be resolved', () => {
    const score = computeRiskScore(inputs({ unresolvedEdgeCount: 3 }));

    expect(factor(score, 'unresolved-edges')).toMatchObject({ rawValue: 3, points: 3 });
  });

  it('adds points when no test file depends on it', () => {
    const untested = computeRiskScore(inputs({ hasTestDependents: false }));
    const tested = computeRiskScore(inputs({ hasTestDependents: true }));

    expect(untested.score - tested.score).toBe(5);
  });

  it('never exceeds 100', () => {
    const edges = Array.from({ length: 200 }, (_, i) => edge(`file:src/d${i}.ts`, 'file:src/core.ts'));
    const score = computeRiskScore(
      inputs({
        index: new GraphIndex(edges),
        inCycle: true,
        reachableFromEntryPoint: true,
        unresolvedEdgeCount: 99,
        hasTestDependents: false,
      }),
    );

    expect(score.score).toBeLessThanOrEqual(100);
  });

  it('exposes a factor breakdown that sums to the score', () => {
    const index = new GraphIndex([
      edge('file:src/a.ts', 'file:src/core.ts'),
      edge('file:src/b.ts', 'file:src/a.ts'),
    ]);

    const score = computeRiskScore(
      inputs({ index, inCycle: true, reachableFromEntryPoint: true, unresolvedEdgeCount: 1 }),
    );

    const total = score.factors.reduce((sum, f) => sum + f.points, 0);
    expect(score.score).toBe(Math.round(total));
  });

  it('explains every factor in plain language', () => {
    const score = computeRiskScore(inputs());

    expect(score.factors).toHaveLength(6);
    for (const item of score.factors) {
      expect(item.explanation.length).toBeGreaterThan(10);
      expect(item.maxPoints).toBeGreaterThan(0);
    }
    expect(score.formulaDescription).toMatch(/not a prediction/);
  });

  it('is deterministic for the same inputs', () => {
    const index = new GraphIndex([edge('file:src/a.ts', 'file:src/core.ts')]);

    expect(computeRiskScore(inputs({ index }))).toEqual(computeRiskScore(inputs({ index })));
  });

  it('renders a symbol node id as path#symbol', () => {
    const score = computeRiskScore(inputs({ nodeId: 'symbol:src/core.ts#helper' }));

    expect(score.path).toBe('src/core.ts#helper');
  });
});
