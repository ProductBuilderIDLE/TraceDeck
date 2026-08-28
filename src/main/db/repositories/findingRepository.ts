import type { Db } from '../connection';
import type { Finding, FindingDetails, FindingType, Severity } from '@shared/types';
import { nowIso, parseJson, type FindingRow } from '../rows';

function mapFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    projectId: row.project_id,
    scanId: row.scan_id,
    findingType: row.finding_type as FindingType,
    severity: row.severity as Severity,
    title: row.title,
    description: row.description,
    relatedNodeIds: parseJson<string[]>(row.related_node_ids_json, []),
    details: parseJson<FindingDetails>(row.details_json, {} as FindingDetails),
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    dismissedAt: row.dismissed_at,
  };
}

export interface FindingInsertInput {
  projectId: number;
  scanId: number;
  findingType: FindingType;
  severity: Severity;
  title: string;
  description: string;
  relatedNodeIds: string[];
  details: FindingDetails;
  /** Stable identity across scans, used to carry dismissals forward. */
  fingerprint: string;
}

export interface ListFindingsOptions {
  findingType?: FindingType;
  includeDismissed?: boolean;
}

export class FindingRepository {
  constructor(private readonly db: Db) {}

  /**
   * Replaces the findings of the given types for a project. A finding whose fingerprint the
   * user previously dismissed is re-inserted already dismissed, so review decisions survive
   * rescans.
   */
  replaceForScan(
    projectId: number,
    scanId: number,
    findingTypes: FindingType[],
    findings: FindingInsertInput[],
  ): void {
    const deleteByType = this.db.prepare(
      `DELETE FROM analysis_findings WHERE project_id = ? AND finding_type = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO analysis_findings
         (project_id, scan_id, finding_type, severity, title, description,
          related_node_ids_json, details_json, fingerprint, created_at, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const findDismissal = this.db.prepare<[number, string, string], { created_at: string }>(
      `SELECT created_at FROM finding_dismissals
       WHERE project_id = ? AND finding_type = ? AND fingerprint = ?`,
    );

    const timestamp = nowIso();

    const run = this.db.transaction(() => {
      for (const findingType of findingTypes) {
        deleteByType.run(projectId, findingType);
      }
      for (const finding of findings) {
        const dismissal = findDismissal.get(projectId, finding.findingType, finding.fingerprint);
        insert.run(
          finding.projectId,
          finding.scanId,
          finding.findingType,
          finding.severity,
          finding.title,
          finding.description,
          JSON.stringify(finding.relatedNodeIds),
          JSON.stringify(finding.details),
          finding.fingerprint,
          timestamp,
          dismissal ? dismissal.created_at : null,
        );
      }
      void scanId;
    });

    run();
  }

  list(projectId: number, options: ListFindingsOptions = {}): Finding[] {
    const clauses = ['project_id = ?'];
    const params: Array<number | string> = [projectId];

    if (options.findingType) {
      clauses.push('finding_type = ?');
      params.push(options.findingType);
    }
    if (!options.includeDismissed) {
      clauses.push('dismissed_at IS NULL');
    }

    const rows = this.db
      .prepare<Array<number | string>, FindingRow>(
        `SELECT * FROM analysis_findings
         WHERE ${clauses.join(' AND ')}
         ORDER BY CASE severity
                    WHEN 'high' THEN 0 WHEN 'medium' THEN 1
                    WHEN 'low' THEN 2 ELSE 3 END,
                  title`,
      )
      .all(...params);

    return rows.map(mapFinding);
  }

  findById(id: number): Finding | null {
    const row = this.db
      .prepare<[number], FindingRow>(`SELECT * FROM analysis_findings WHERE id = ?`)
      .get(id);
    return row ? mapFinding(row) : null;
  }

  countByType(projectId: number, findingType: FindingType): number {
    const row = this.db
      .prepare<[number, string], { count: number }>(
        `SELECT COUNT(*) AS count FROM analysis_findings
         WHERE project_id = ? AND finding_type = ? AND dismissed_at IS NULL`,
      )
      .get(projectId, findingType);
    return row?.count ?? 0;
  }

  /** Records the decision against the finding's fingerprint so it outlives this scan's rows. */
  setDismissed(findingId: number, dismissed: boolean): boolean {
    const row = this.db
      .prepare<[number], Pick<FindingRow, 'project_id' | 'finding_type' | 'fingerprint'>>(
        `SELECT project_id, finding_type, fingerprint FROM analysis_findings WHERE id = ?`,
      )
      .get(findingId);
    if (!row) return false;

    const finding = { projectId: row.project_id, findingType: row.finding_type };
    const fingerprint = row.fingerprint;

    const run = this.db.transaction(() => {
      if (dismissed) {
        const timestamp = nowIso();
        this.db
          .prepare(
            `INSERT INTO finding_dismissals (project_id, finding_type, fingerprint, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (project_id, finding_type, fingerprint) DO NOTHING`,
          )
          .run(finding.projectId, finding.findingType, fingerprint, timestamp);
        this.db
          .prepare(`UPDATE analysis_findings SET dismissed_at = ? WHERE id = ?`)
          .run(timestamp, findingId);
      } else {
        this.db
          .prepare(
            `DELETE FROM finding_dismissals
             WHERE project_id = ? AND finding_type = ? AND fingerprint = ?`,
          )
          .run(finding.projectId, finding.findingType, fingerprint);
        this.db
          .prepare(`UPDATE analysis_findings SET dismissed_at = NULL WHERE id = ?`)
          .run(findingId);
      }
    });

    run();
    return true;
  }
}
