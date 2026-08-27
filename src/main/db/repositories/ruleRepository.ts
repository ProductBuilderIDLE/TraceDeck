import type { Db } from '../connection';
import type {
  ArchitectureRule,
  ArchitectureRuleConfiguration,
  ArchitectureRuleType,
} from '@shared/types';
import { fromBool, nowIso, parseJson, toBool, type RuleRow } from '../rows';

const DEFAULT_RULE_CONFIGURATION: ArchitectureRuleConfiguration = {
  severity: 'medium',
  exceptions: [],
};

function mapRule(row: RuleRow): ArchitectureRule {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    enabled: toBool(row.enabled),
    ruleType: row.rule_type as ArchitectureRuleType,
    sourcePattern: row.source_pattern,
    targetPattern: row.target_pattern,
    configuration: {
      ...DEFAULT_RULE_CONFIGURATION,
      ...parseJson<Partial<ArchitectureRuleConfiguration>>(row.configuration_json, {}),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RuleUpsertInput {
  id?: number;
  projectId: number;
  name: string;
  enabled: boolean;
  ruleType: ArchitectureRuleType;
  sourcePattern: string;
  targetPattern: string;
  configuration: ArchitectureRuleConfiguration;
}

export class RuleRepository {
  constructor(private readonly db: Db) {}

  listByProject(projectId: number): ArchitectureRule[] {
    return this.db
      .prepare<[number], RuleRow>(
        `SELECT * FROM architecture_rules WHERE project_id = ? ORDER BY name`,
      )
      .all(projectId)
      .map(mapRule);
  }

  listEnabled(projectId: number): ArchitectureRule[] {
    return this.listByProject(projectId).filter((rule) => rule.enabled);
  }

  findById(id: number): ArchitectureRule | null {
    const row = this.db
      .prepare<[number], RuleRow>(`SELECT * FROM architecture_rules WHERE id = ?`)
      .get(id);
    return row ? mapRule(row) : null;
  }

  upsert(input: RuleUpsertInput): ArchitectureRule {
    const timestamp = nowIso();

    if (input.id !== undefined) {
      this.db
        .prepare(
          `UPDATE architecture_rules
           SET name = ?, enabled = ?, rule_type = ?, source_pattern = ?,
               target_pattern = ?, configuration_json = ?, updated_at = ?
           WHERE id = ? AND project_id = ?`,
        )
        .run(
          input.name,
          fromBool(input.enabled),
          input.ruleType,
          input.sourcePattern,
          input.targetPattern,
          JSON.stringify(input.configuration),
          timestamp,
          input.id,
          input.projectId,
        );
      const updated = this.findById(input.id);
      if (!updated) throw new Error(`Rule ${input.id} does not exist in this project.`);
      return updated;
    }

    const result = this.db
      .prepare(
        `INSERT INTO architecture_rules
           (project_id, name, enabled, rule_type, source_pattern, target_pattern,
            configuration_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.name,
        fromBool(input.enabled),
        input.ruleType,
        input.sourcePattern,
        input.targetPattern,
        JSON.stringify(input.configuration),
        timestamp,
        timestamp,
      );

    return this.findById(Number(result.lastInsertRowid)) as ArchitectureRule;
  }

  remove(id: number): boolean {
    return this.db.prepare(`DELETE FROM architecture_rules WHERE id = ?`).run(id).changes > 0;
  }
}
