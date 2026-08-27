import type { Db } from '../connection';
import type { Scan, ScanStatus, ScanSummary } from '@shared/types';
import { nowIso, parseJson, type ScanRow } from '../rows';

function mapScan(row: ScanRow): Scan {
  return {
    id: row.id,
    projectId: row.project_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status as ScanStatus,
    gitCommit: row.git_commit,
    totalFiles: row.total_files,
    parsedFiles: row.parsed_files,
    errorCount: row.error_count,
    summary: row.summary_json ? parseJson<ScanSummary | null>(row.summary_json, null) : null,
  };
}

export interface CompleteScanInput {
  status: ScanStatus;
  totalFiles: number;
  parsedFiles: number;
  errorCount: number;
  summary: ScanSummary | null;
}

export class ScanRepository {
  constructor(private readonly db: Db) {}

  start(projectId: number, gitCommit: string | null): Scan {
    const result = this.db
      .prepare(
        `INSERT INTO scans (project_id, started_at, status, git_commit) VALUES (?, ?, 'running', ?)`,
      )
      .run(projectId, nowIso(), gitCommit);
    return this.findById(Number(result.lastInsertRowid)) as Scan;
  }

  findById(id: number): Scan | null {
    const row = this.db.prepare<[number], ScanRow>(`SELECT * FROM scans WHERE id = ?`).get(id);
    return row ? mapScan(row) : null;
  }

  latestForProject(projectId: number): Scan | null {
    const row = this.db
      .prepare<[number], ScanRow>(
        `SELECT * FROM scans WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId);
    return row ? mapScan(row) : null;
  }

  /** The newest scan that finished cleanly; queries read from this rather than a running scan. */
  latestCompletedForProject(projectId: number): Scan | null {
    const row = this.db
      .prepare<[number], ScanRow>(
        `SELECT * FROM scans
         WHERE project_id = ? AND status = 'completed'
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId);
    return row ? mapScan(row) : null;
  }

  complete(scanId: number, input: CompleteScanInput): Scan | null {
    this.db
      .prepare(
        `UPDATE scans
         SET completed_at = ?, status = ?, total_files = ?, parsed_files = ?,
             error_count = ?, summary_json = ?
         WHERE id = ?`,
      )
      .run(
        nowIso(),
        input.status,
        input.totalFiles,
        input.parsedFiles,
        input.errorCount,
        input.summary ? JSON.stringify(input.summary) : null,
        scanId,
      );
    return this.findById(scanId);
  }

  fail(scanId: number, message: string): void {
    this.db
      .prepare(`UPDATE scans SET completed_at = ?, status = 'failed', summary_json = ? WHERE id = ?`)
      .run(nowIso(), JSON.stringify({ error: message }), scanId);
  }

  /**
   * Deletes every scan for the project except the given one. Rows in files, symbols, and
   * graph_edges cascade with their scan, which keeps the database from growing without bound
   * across repeated rescans.
   */
  pruneOlderScans(projectId: number, keepScanId: number): number {
    const result = this.db
      .prepare(`DELETE FROM scans WHERE project_id = ? AND id != ?`)
      .run(projectId, keepScanId);
    return result.changes;
  }

  /** Recovers from a crash mid-scan: a 'running' scan from a previous process is never valid. */
  markInterruptedScansFailed(): number {
    const result = this.db
      .prepare(
        `UPDATE scans SET status = 'failed', completed_at = ?
         WHERE status = 'running'`,
      )
      .run(nowIso());
    return result.changes;
  }
}
