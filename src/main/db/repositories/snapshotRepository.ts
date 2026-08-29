import type { Db } from '../connection';
import { nowIso, parseJson } from '../rows';

export interface SnapshotFingerprint {
  fingerprint: string;
  title: string;
}

export interface ScanSnapshot {
  id: number;
  projectId: number;
  scanId: number;
  createdAt: string;
  fingerprints: SnapshotFingerprint[];
}

export class SnapshotRepository {
  constructor(private readonly db: Db) {}

  insert(projectId: number, scanId: number, fingerprints: SnapshotFingerprint[]): ScanSnapshot {
    const createdAt = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO scan_snapshots (project_id, scan_id, created_at, fingerprints_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(projectId, scanId, createdAt, JSON.stringify(fingerprints));
    return {
      id: Number(result.lastInsertRowid),
      projectId,
      scanId,
      createdAt,
      fingerprints,
    };
  }

  latestTwo(projectId: number): ScanSnapshot[] {
    const rows = this.db
      .prepare<
        [number],
        {
          id: number;
          project_id: number;
          scan_id: number;
          created_at: string;
          fingerprints_json: string;
        }
      >(
        `SELECT * FROM scan_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT 2`,
      )
      .all(projectId);
    return rows.map((row) => {
      const parsed = parseJson<SnapshotFingerprint[]>(row.fingerprints_json, []);
      return {
        id: row.id,
        projectId: row.project_id,
        scanId: row.scan_id,
        createdAt: row.created_at,
        fingerprints: Array.isArray(parsed) ? parsed : [],
      };
    });
  }

  prune(projectId: number, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM scan_snapshots
         WHERE project_id = ?
           AND id NOT IN (
             SELECT id FROM scan_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT ?
           )`,
      )
      .run(projectId, projectId, keep);
  }
}
