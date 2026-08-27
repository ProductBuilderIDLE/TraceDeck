import type { Db } from '../connection';
import type { ReportConfiguration, ReportFormat, SavedReport } from '@shared/types';
import { nowIso, parseJson, type ReportRow } from '../rows';

function mapReport(row: ReportRow): SavedReport {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    reportType: row.report_type as ReportFormat,
    configuration: parseJson<ReportConfiguration>(row.configuration_json, {
      title: row.name,
      scope: { kind: 'project' },
      sections: [],
      format: row.report_type as ReportFormat,
    }),
    createdAt: row.created_at,
  };
}

export class ReportRepository {
  constructor(private readonly db: Db) {}

  listByProject(projectId: number): SavedReport[] {
    return this.db
      .prepare<[number], ReportRow>(
        `SELECT * FROM saved_reports WHERE project_id = ? ORDER BY created_at DESC`,
      )
      .all(projectId)
      .map(mapReport);
  }

  create(projectId: number, name: string, configuration: ReportConfiguration): SavedReport {
    const result = this.db
      .prepare(
        `INSERT INTO saved_reports (project_id, name, report_type, configuration_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, name, configuration.format, JSON.stringify(configuration), nowIso());

    const row = this.db
      .prepare<[number], ReportRow>(`SELECT * FROM saved_reports WHERE id = ?`)
      .get(Number(result.lastInsertRowid));
    return mapReport(row as ReportRow);
  }

  remove(id: number): boolean {
    return this.db.prepare(`DELETE FROM saved_reports WHERE id = ?`).run(id).changes > 0;
  }
}
