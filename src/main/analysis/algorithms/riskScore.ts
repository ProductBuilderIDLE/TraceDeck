import type { RiskScore, RiskScoreFactor } from '@shared/types';
import { parseNodeId } from '@shared/nodeIds';
import type { GraphIndex } from './graphIndex';
import { countAllDependents } from './blastRadius';

export interface RiskScoreInputs {
  nodeId: string;
  index: GraphIndex;
  inCycle: boolean;
  reachableFromEntryPoint: boolean;
  unresolvedEdgeCount: number;
  hasTestDependents: boolean;
}

export const RISK_FORMULA_DESCRIPTION =
  'Change impact is the sum of six weighted factors, each capped at its own maximum. ' +
  'It is a deterministic arithmetic summary of the dependency graph, not a prediction and ' +
  'not a judgement about code quality. A high score means many things point at this file, ' +
  'so a change here is worth reviewing carefully.';

/**
 * Each factor's weight, chosen so that reach through the graph dominates and the remaining
 * signals act as modifiers. The weights are constants rather than tuned parameters precisely
 * so that the same graph always produces the same score, and so the breakdown shown in the
 * UI fully explains the number.
 */
const WEIGHTS = {
  directDependents: { max: 30, per: 3 },
  transitiveDependents: { max: 30, per: 1 },
  reachableFromEntryPoint: { max: 15 },
  inCycle: { max: 15 },
  unresolvedEdges: { max: 5, per: 1 },
  testCoverage: { max: 5 },
} as const;

function cap(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

/**
 * Computes an explainable 0-100 change impact score.
 *
 * Every factor returns its own raw value, the points it contributed, and the maximum it could
 * have contributed, so the inspector can show the full arithmetic rather than a bare number.
 */
export function computeRiskScore(inputs: RiskScoreInputs): RiskScore {
  const { nodeId, index, inCycle, reachableFromEntryPoint, unresolvedEdgeCount, hasTestDependents } =
    inputs;

  const directDependents = index.dependentsOf(nodeId).length;
  const totalDependents = countAllDependents(index, nodeId);
  const transitiveDependents = Math.max(0, totalDependents - directDependents);

  const factors: RiskScoreFactor[] = [
    {
      key: 'direct-dependents',
      label: 'Files that import this directly',
      rawValue: directDependents,
      points: cap(directDependents * WEIGHTS.directDependents.per, WEIGHTS.directDependents.max),
      maxPoints: WEIGHTS.directDependents.max,
      explanation: `${directDependents} file(s) import this directly, at ${WEIGHTS.directDependents.per} points each.`,
    },
    {
      key: 'transitive-dependents',
      label: 'Files reached indirectly',
      rawValue: transitiveDependents,
      points: cap(
        transitiveDependents * WEIGHTS.transitiveDependents.per,
        WEIGHTS.transitiveDependents.max,
      ),
      maxPoints: WEIGHTS.transitiveDependents.max,
      explanation: `${transitiveDependents} further file(s) depend on this through a chain, at ${WEIGHTS.transitiveDependents.per} point each.`,
    },
    {
      key: 'entry-point-reachable',
      label: 'Reachable from an entry point',
      rawValue: reachableFromEntryPoint,
      points: reachableFromEntryPoint ? WEIGHTS.reachableFromEntryPoint.max : 0,
      maxPoints: WEIGHTS.reachableFromEntryPoint.max,
      explanation: reachableFromEntryPoint
        ? 'This file is reachable from an inferred entry point, so it runs in the shipped product.'
        : 'No inferred entry point reaches this file through resolved imports.',
    },
    {
      key: 'in-cycle',
      label: 'Part of a circular dependency',
      rawValue: inCycle,
      points: inCycle ? WEIGHTS.inCycle.max : 0,
      maxPoints: WEIGHTS.inCycle.max,
      explanation: inCycle
        ? 'This file is inside an import cycle, so changes here can have effects that loop back.'
        : 'This file is not part of any detected import cycle.',
    },
    {
      key: 'unresolved-edges',
      label: 'Imports that could not be resolved',
      rawValue: unresolvedEdgeCount,
      points: cap(unresolvedEdgeCount * WEIGHTS.unresolvedEdges.per, WEIGHTS.unresolvedEdges.max),
      maxPoints: WEIGHTS.unresolvedEdges.max,
      explanation:
        unresolvedEdgeCount > 0
          ? `${unresolvedEdgeCount} import(s) here could not be resolved, so the real impact may be larger than shown.`
          : 'Every import in this file resolved to a known target.',
    },
    {
      key: 'test-coverage-signal',
      label: 'No test file depends on this',
      rawValue: !hasTestDependents,
      points: hasTestDependents ? 0 : WEIGHTS.testCoverage.max,
      maxPoints: WEIGHTS.testCoverage.max,
      explanation: hasTestDependents
        ? 'At least one test file imports this, so a change has some automated check behind it.'
        : 'No test file in this project imports this, so a change here is unverified by tests.',
    },
  ];

  const score = cap(
    Math.round(factors.reduce((total, factor) => total + factor.points, 0)),
    100,
  );

  const parsed = parseNodeId(nodeId);
  const path = parsed
    ? parsed.symbolName
      ? `${parsed.path}#${parsed.symbolName}`
      : parsed.path
    : nodeId;

  return { nodeId, path, score, percentile: 0, factors, formulaDescription: RISK_FORMULA_DESCRIPTION };
}

export const MAX_POSSIBLE_SCORE = Object.values(WEIGHTS).reduce(
  (total, weight) => total + weight.max,
  0,
);
