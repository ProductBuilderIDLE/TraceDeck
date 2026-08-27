import type { ArchitectureRuleType, Severity } from '@shared/types';
import type { DataStore } from '../db';
import { validateGlob } from '../utils/glob';
import {
  asObject,
  requireBoolean,
  requireEnum,
  requireInt,
  requireNonEmptyString,
  requireStringArray,
  optionalInt,
} from '../utils/validation';
import { HandledError, type HandlerMap } from './registry';
import { evaluateArchitectureRules, type ImportFact } from '../analysis/algorithms/architectureRules';
import { DEPENDENCY_EDGE_TYPES } from '../analysis/algorithms/graphIndex';
import { fingerprint } from '../utils/hashing';

const RULE_TYPES: readonly ArchitectureRuleType[] = ['forbid-import'];
const SEVERITIES: readonly Severity[] = ['info', 'low', 'medium', 'high'];

function requireGlob(value: unknown, field: string): string {
  const pattern = requireNonEmptyString(value, field, 512);
  const result = validateGlob(pattern);
  if (!result.valid) {
    throw new HandledError(`${field}: ${result.error}`, 'INVALID_PATTERN');
  }
  return pattern;
}

export function ruleHandlers(store: DataStore): HandlerMap {
  return {
    'rules:list': async (payload) => {
      const value = asObject(payload);
      return store.rules.listByProject(requireInt(value['projectId'], 'projectId', 1));
    },

    'rules:upsert': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);

      if (!store.projects.findById(projectId)) {
        throw new HandledError('That project no longer exists.', 'NOT_FOUND');
      }

      const configuration = asObject(value['configuration'] ?? {}, 'configuration');
      const exceptions = requireStringArray(
        configuration['exceptions'] ?? [],
        'configuration.exceptions',
        100,
      );
      for (const [position, pattern] of exceptions.entries()) {
        requireGlob(pattern, `configuration.exceptions[${position}]`);
      }

      const id = optionalInt(value['id'], 'id', 1);

      return store.rules.upsert({
        ...(id !== undefined ? { id } : {}),
        projectId,
        name: requireNonEmptyString(value['name'], 'name', 200),
        enabled: requireBoolean(value['enabled'], 'enabled'),
        ruleType: requireEnum(value['ruleType'], 'ruleType', RULE_TYPES),
        sourcePattern: requireGlob(value['sourcePattern'], 'sourcePattern'),
        targetPattern: requireGlob(value['targetPattern'], 'targetPattern'),
        configuration: {
          severity: requireEnum(
            configuration['severity'] ?? 'medium',
            'configuration.severity',
            SEVERITIES,
          ),
          exceptions,
        },
      });
    },

    'rules:delete': async (payload) => {
      const value = asObject(payload);
      return { deleted: store.rules.remove(requireInt(value['ruleId'], 'ruleId', 1)) };
    },

    /**
     * Re-evaluates rules against the stored graph without rescanning the filesystem, so the
     * violations view updates immediately after a rule is edited.
     */
    'rules:evaluate': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);

      const project = store.projects.findById(projectId);
      if (!project) throw new HandledError('That project no longer exists.', 'NOT_FOUND');

      const scan = store.scans.latestCompletedForProject(projectId);
      if (!scan) {
        throw new HandledError('Scan this project before evaluating rules.', 'NO_SCAN');
      }

      const filesById = new Map(
        store.files.listByProject(projectId).map((file) => [file.id, file.relativePath]),
      );

      const facts: ImportFact[] = [];
      for (const edge of store.edges.listByProject(projectId)) {
        if (!DEPENDENCY_EDGE_TYPES.includes(edge.edgeType)) continue;
        if (edge.metadata.unresolved) continue;

        const fromPath = filesById.get(edge.sourceFileId ?? -1);
        if (!fromPath) continue;

        facts.push({
          fromPath,
          toPath: edge.toNodeId.startsWith('file:') ? edge.toNodeId.slice('file:'.length) : null,
          specifier: edge.metadata.specifier ?? '',
          line: edge.sourceLine,
        });
      }

      const { violations } = evaluateArchitectureRules(store.rules.listEnabled(projectId), facts);

      store.findings.replaceForScan(
        projectId,
        scan.id,
        ['architecture-violation'],
        violations.map((violation) => ({
          projectId,
          scanId: scan.id,
          findingType: 'architecture-violation' as const,
          severity: violation.severity,
          title: violation.ruleName,
          description:
            `"${violation.sourcePath}" imports "${violation.targetPath}", which the rule ` +
            `"${violation.ruleName}" forbids.`,
          relatedNodeIds: [
            `file:${violation.sourcePath}`,
            `file:${violation.targetPath}`,
          ],
          details: {
            kind: 'architecture-violation' as const,
            ruleId: violation.ruleId,
            ruleName: violation.ruleName,
            sourcePath: violation.sourcePath,
            targetPath: violation.targetPath,
            line: violation.line,
            specifier: violation.specifier,
          },
          // Must match the scheme the scanner uses, or dismissals stop carrying across.
          fingerprint: fingerprint(
            'arch',
            violation.ruleId,
            violation.sourcePath,
            violation.targetPath,
          ),
        })),
      );

      return { violationCount: violations.length };
    },
  };
}
