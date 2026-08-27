import type { Db } from '../connection';
import type { SourceFile } from '@shared/types';
import { fromBool, toBool, type FileRow } from '../rows';

function mapFile(row: FileRow): SourceFile {
  return {
    id: row.id,
    projectId: row.project_id,
    relativePath: row.relative_path,
    absolutePath: row.absolute_path,
    extension: row.extension,
    contentHash: row.content_hash,
    modifiedAt: row.modified_at,
    isEntryPoint: toBool(row.is_entry_point),
    scanId: row.scan_id,
  };
}

export interface FileUpsertInput {
  projectId: number;
  relativePath: string;
  absolutePath: string;
  extension: string;
  contentHash: string;
  modifiedAt: string;
  isEntryPoint: boolean;
  scanId: number;
}

/** Just enough of a stored file to decide whether it needs re-parsing. */
export interface FileFingerprint {
  id: number;
  relativePath: string;
  contentHash: string;
  modifiedAt: string;
}

export class FileRepository {
  constructor(private readonly db: Db) {}

  listByProject(projectId: number): SourceFile[] {
    return this.db
      .prepare<[number], FileRow>(
        `SELECT * FROM files WHERE project_id = ? ORDER BY relative_path`,
      )
      .all(projectId)
      .map(mapFile);
  }

  findByPath(projectId: number, relativePath: string): SourceFile | null {
    const row = this.db
      .prepare<[number, string], FileRow>(
        `SELECT * FROM files WHERE project_id = ? AND relative_path = ?`,
      )
      .get(projectId, relativePath);
    return row ? mapFile(row) : null;
  }

  findById(id: number): SourceFile | null {
    const row = this.db.prepare<[number], FileRow>(`SELECT * FROM files WHERE id = ?`).get(id);
    return row ? mapFile(row) : null;
  }

  fingerprints(projectId: number): Map<string, FileFingerprint> {
    const rows = this.db
      .prepare<[number], Pick<FileRow, 'id' | 'relative_path' | 'content_hash' | 'modified_at'>>(
        `SELECT id, relative_path, content_hash, modified_at FROM files WHERE project_id = ?`,
      )
      .all(projectId);

    return new Map(
      rows.map((row) => [
        row.relative_path,
        {
          id: row.id,
          relativePath: row.relative_path,
          contentHash: row.content_hash,
          modifiedAt: row.modified_at,
        },
      ]),
    );
  }

  /**
   * Inserts or updates one row per file in a single transaction and returns the resulting
   * row ids keyed by relative path. Scans touch thousands of files, so this is the hot path
   * for write throughput.
   */
  upsertMany(inputs: FileUpsertInput[]): Map<string, number> {
    const statement = this.db.prepare(
      `INSERT INTO files
         (project_id, relative_path, absolute_path, extension, content_hash,
          modified_at, is_entry_point, scan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, relative_path) DO UPDATE SET
         absolute_path  = excluded.absolute_path,
         extension      = excluded.extension,
         content_hash   = excluded.content_hash,
         modified_at    = excluded.modified_at,
         is_entry_point = excluded.is_entry_point,
         scan_id        = excluded.scan_id`,
    );

    const selectId = this.db.prepare<[number, string], { id: number }>(
      `SELECT id FROM files WHERE project_id = ? AND relative_path = ?`,
    );

    const ids = new Map<string, number>();

    const run = this.db.transaction((batch: FileUpsertInput[]) => {
      for (const input of batch) {
        statement.run(
          input.projectId,
          input.relativePath,
          input.absolutePath,
          input.extension,
          input.contentHash,
          input.modifiedAt,
          fromBool(input.isEntryPoint),
          input.scanId,
        );
        const row = selectId.get(input.projectId, input.relativePath);
        if (row) ids.set(input.relativePath, row.id);
      }
    });

    run(inputs);
    return ids;
  }

  /**
   * Moves unchanged files onto the current scan so that pruning older scans does not delete
   * rows that are still accurate.
   */
  reassignToScan(fileIds: number[], scanId: number): void {
    if (fileIds.length === 0) return;
    const statement = this.db.prepare(`UPDATE files SET scan_id = ? WHERE id = ?`);
    const run = this.db.transaction((ids: number[]) => {
      for (const id of ids) statement.run(scanId, id);
    });
    run(fileIds);
  }

  /** Removes files that no longer exist on disk, cascading their symbols and edges. */
  removeByIds(fileIds: number[]): number {
    if (fileIds.length === 0) return 0;
    const statement = this.db.prepare(`DELETE FROM files WHERE id = ?`);
    let removed = 0;
    const run = this.db.transaction((ids: number[]) => {
      for (const id of ids) removed += statement.run(id).changes;
    });
    run(fileIds);
    return removed;
  }

  countByProject(projectId: number): number {
    const row = this.db
      .prepare<[number], { count: number }>(
        `SELECT COUNT(*) AS count FROM files WHERE project_id = ?`,
      )
      .get(projectId);
    return row?.count ?? 0;
  }

  setEntryPoints(projectId: number, relativePaths: string[]): void {
    const clear = this.db.prepare(`UPDATE files SET is_entry_point = 0 WHERE project_id = ?`);
    const mark = this.db.prepare(
      `UPDATE files SET is_entry_point = 1 WHERE project_id = ? AND relative_path = ?`,
    );
    const run = this.db.transaction((paths: string[]) => {
      clear.run(projectId);
      for (const path of paths) mark.run(projectId, path);
    });
    run(relativePaths);
  }
}
