import type { Db } from '../connection';
import type { SymbolKind, SymbolMetadata, SymbolRecord } from '@shared/types';
import { fromBool, parseJson, toBool, type SymbolRow } from '../rows';

function mapSymbol(row: SymbolRow): SymbolRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    fileId: row.file_id,
    name: row.name,
    kind: row.kind as SymbolKind,
    isExported: toBool(row.is_exported),
    isDefaultExport: toBool(row.is_default_export),
    startLine: row.start_line,
    endLine: row.end_line,
    metadata: parseJson<SymbolMetadata>(row.metadata_json, {}),
    scanId: row.scan_id,
  };
}

export interface SymbolInsertInput {
  projectId: number;
  fileId: number;
  name: string;
  kind: SymbolKind;
  isExported: boolean;
  isDefaultExport: boolean;
  startLine: number;
  endLine: number;
  metadata: SymbolMetadata;
  scanId: number;
}

export interface ExportedSymbolWithPath extends SymbolRecord {
  relativePath: string;
}

/** Neutralises `%`, `_`, and the escape character itself so LIKE matches the literal text. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class SymbolRepository {
  constructor(private readonly db: Db) {}

  listByFile(fileId: number): SymbolRecord[] {
    return this.db
      .prepare<[number], SymbolRow>(`SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line`)
      .all(fileId)
      .map(mapSymbol);
  }

  insertMany(inputs: SymbolInsertInput[]): void {
    if (inputs.length === 0) return;

    const statement = this.db.prepare(
      `INSERT INTO symbols
         (project_id, file_id, name, kind, is_exported, is_default_export,
          start_line, end_line, metadata_json, scan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const run = this.db.transaction((batch: SymbolInsertInput[]) => {
      for (const input of batch) {
        statement.run(
          input.projectId,
          input.fileId,
          input.name,
          input.kind,
          fromBool(input.isExported),
          fromBool(input.isDefaultExport),
          input.startLine,
          input.endLine,
          JSON.stringify(input.metadata),
          input.scanId,
        );
      }
    });

    run(inputs);
  }

  /** Clears symbols for files about to be re-parsed, so a rescan never duplicates them. */
  deleteByFileIds(fileIds: number[]): void {
    if (fileIds.length === 0) return;
    const statement = this.db.prepare(`DELETE FROM symbols WHERE file_id = ?`);
    const run = this.db.transaction((ids: number[]) => {
      for (const id of ids) statement.run(id);
    });
    run(fileIds);
  }

  reassignToScan(fileIds: number[], scanId: number): void {
    if (fileIds.length === 0) return;
    const statement = this.db.prepare(`UPDATE symbols SET scan_id = ? WHERE file_id = ?`);
    const run = this.db.transaction((ids: number[]) => {
      for (const id of ids) statement.run(scanId, id);
    });
    run(fileIds);
  }

  listExported(projectId: number): ExportedSymbolWithPath[] {
    const rows = this.db
      .prepare<[number], SymbolRow & { relative_path: string }>(
        `SELECT s.*, f.relative_path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.project_id = ? AND s.is_exported = 1
         ORDER BY f.relative_path, s.start_line`,
      )
      .all(projectId);

    return rows.map((row) => ({ ...mapSymbol(row), relativePath: row.relative_path }));
  }

  /** `query` is raw user input; LIKE metacharacters in it are matched literally. */
  search(projectId: number, query: string, limit: number): ExportedSymbolWithPath[] {
    const pattern = `%${escapeLikePattern(query)}%`;
    const rows = this.db
      .prepare<[number, string, number], SymbolRow & { relative_path: string }>(
        `SELECT s.*, f.relative_path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.project_id = ? AND s.name LIKE ? ESCAPE '\\'
         ORDER BY s.is_exported DESC, LENGTH(s.name), s.name
         LIMIT ?`,
      )
      .all(projectId, pattern, limit);

    return rows.map((row) => ({ ...mapSymbol(row), relativePath: row.relative_path }));
  }

  countByProject(projectId: number): number {
    const row = this.db
      .prepare<[number], { count: number }>(
        `SELECT COUNT(*) AS count FROM symbols WHERE project_id = ?`,
      )
      .get(projectId);
    return row?.count ?? 0;
  }
}
