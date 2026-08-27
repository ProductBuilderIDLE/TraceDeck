import type { ArchitectureRule, Severity } from '@shared/types';
import { createGlobMatcher, createGlobMatchers, matchesAny, toPosixPath } from '../../utils/glob';

export interface ImportFact {
  /** Relative path of the file containing the import. */
  fromPath: string;
  /** Relative path of the imported file, or null when it could not be resolved. */
  toPath: string | null;
  specifier: string;
  line: number | null;
}

export interface RuleViolation {
  ruleId: number;
  ruleName: string;
  severity: Severity;
  sourcePath: string;
  targetPath: string;
  specifier: string;
  line: number | null;
}

export interface RuleEvaluationResult {
  violations: RuleViolation[];
  /** Rules whose patterns did not compile; surfaced in the editor rather than failing a scan. */
  invalidRules: Array<{ ruleId: number; ruleName: string; error: string }>;
}

interface CompiledRule {
  rule: ArchitectureRule;
  source: ReturnType<typeof createGlobMatcher>;
  target: ReturnType<typeof createGlobMatcher>;
  exceptions: ReturnType<typeof createGlobMatchers>;
}

/**
 * Evaluates "files under A must not import from B" rules against resolved imports.
 *
 * Only resolved imports are checked. An unresolved specifier is reported separately as an
 * unresolved import rather than being guessed into a violation, because judging a rule on a
 * path the analyser could not confirm would produce false accusations.
 */
export function evaluateArchitectureRules(
  rules: readonly ArchitectureRule[],
  imports: readonly ImportFact[],
): RuleEvaluationResult {
  const compiled: CompiledRule[] = [];
  const invalidRules: RuleEvaluationResult['invalidRules'] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    try {
      compiled.push({
        rule,
        source: createGlobMatcher(rule.sourcePattern),
        target: createGlobMatcher(rule.targetPattern),
        exceptions: createGlobMatchers(rule.configuration.exceptions),
      });
    } catch (error) {
      invalidRules.push({
        ruleId: rule.id,
        ruleName: rule.name,
        error: error instanceof Error ? error.message : 'Invalid pattern',
      });
    }
  }

  const violations: RuleViolation[] = [];

  for (const fact of imports) {
    if (fact.toPath === null) continue;

    const fromPath = toPosixPath(fact.fromPath);
    const toPath = toPosixPath(fact.toPath);

    // A file importing itself is not an architectural boundary crossing.
    if (fromPath === toPath) continue;

    for (const entry of compiled) {
      if (!entry.source.test(fromPath)) continue;
      if (!entry.target.test(toPath)) continue;
      if (matchesAny(entry.exceptions, fromPath)) continue;

      violations.push({
        ruleId: entry.rule.id,
        ruleName: entry.rule.name,
        severity: entry.rule.configuration.severity,
        sourcePath: fromPath,
        targetPath: toPath,
        specifier: fact.specifier,
        line: fact.line,
      });
    }
  }

  violations.sort(
    (a, b) =>
      a.ruleName.localeCompare(b.ruleName) ||
      a.sourcePath.localeCompare(b.sourcePath) ||
      (a.line ?? 0) - (b.line ?? 0),
  );

  return { violations, invalidRules };
}
