import type { Db } from '../connection';
import type {
  ProjectFile,
  ProjectFileAnalysisStatus,
  ProjectFileCapabilityCounts,
  ProjectFileContentKind,
  ProjectFileEntryKind,
} from '@shared/types';
import { fromBool, toBool, type ProjectFileRow } from '../rows';

function mapProjectFile(row: ProjectFileRow): ProjectFile {
  return {
    id: row.id,
    projectId: row.project_id,
    relativePath: row.relative_path,
    absolutePath: row.absolute_path,
    scanId: row.scan_id,
    entryKind: row.entry_kind as ProjectFileEntryKind,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    modifiedAt: row.modified_at,
    contentKind: row.content_kind as ProjectFileContentKind,
    encoding: row.encoding,
    contentHash: row.content_hash,
    isGitIgnored: toBool(row.is_git_ignored),
    gitignoreRule: row.gitignore_rule,
    isUserExcluded: toBool(row.is_user_excluded),
    analysisStatus: row.analysis_status as ProjectFileAnalysisStatus,
    analysisReason: row.analysis_reason,
  };
}

export interface ProjectFileUpsertInput {
  projectId: number;
  relativePath: string;
  absolutePath: string;
  scanId: number;
  entryKind: ProjectFileEntryKind;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  contentKind: ProjectFileContentKind;
  encoding: string | null;
  contentHash: string | null;
  isGitIgnored: boolean;
  gitignoreRule: string | null;
  isUserExcluded: boolean;
  analysisStatus: ProjectFileAnalysisStatus;
  analysisReason: string;
}

export class ProjectFileRepository {
  constructor(private readonly db: Db) {}

  listByProject(projectId: number): ProjectFile[] {
    return this.db
      .prepare<[number], ProjectFileRow>(
        `SELECT * FROM project_files WHERE project_id = ? ORDER BY relative_path`,
      )
      .all(projectId)
      .map(mapProjectFile);
  }

  findByPath(projectId: number, relativePath: string): ProjectFile | null {
    const row = this.db
      .prepare<[number, string], ProjectFileRow>(
        `SELECT * FROM project_files WHERE project_id = ? AND relative_path = ?`,
      )
      .get(projectId, relativePath);
    return row ? mapProjectFile(row) : null;
  }

  upsertMany(inputs: ProjectFileUpsertInput[]): Map<string, number> {
    const statement = this.db.prepare(
      `INSERT INTO project_files
         (project_id, relative_path, absolute_path, scan_id, entry_kind, extension, size_bytes,
          modified_at, content_kind, encoding, content_hash, is_git_ignored, gitignore_rule,
          is_user_excluded, analysis_status, analysis_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, relative_path) DO UPDATE SET
         absolute_path    = excluded.absolute_path,
         scan_id          = excluded.scan_id,
         entry_kind       = excluded.entry_kind,
         extension        = excluded.extension,
         size_bytes       = excluded.size_bytes,
         modified_at      = excluded.modified_at,
         content_kind     = excluded.content_kind,
         encoding         = excluded.encoding,
         content_hash     = excluded.content_hash,
         is_git_ignored   = excluded.is_git_ignored,
         gitignore_rule   = excluded.gitignore_rule,
         is_user_excluded = excluded.is_user_excluded,
         analysis_status  = excluded.analysis_status,
         analysis_reason  = excluded.analysis_reason`,
    );
    const selectId = this.db.prepare<[number, string], { id: number }>(
      `SELECT id FROM project_files WHERE project_id = ? AND relative_path = ?`,
    );
    const ids = new Map<string, number>();

    const run = this.db.transaction((batch: ProjectFileUpsertInput[]) => {
      for (const input of batch) {
        statement.run(
          input.projectId,
          input.relativePath,
          input.absolutePath,
          input.scanId,
          input.entryKind,
          input.extension,
          input.sizeBytes,
          input.modifiedAt,
          input.contentKind,
          input.encoding,
          input.contentHash,
          fromBool(input.isGitIgnored),
          input.gitignoreRule,
          fromBool(input.isUserExcluded),
          input.analysisStatus,
          input.analysisReason,
        );
        const row = selectId.get(input.projectId, input.relativePath);
        if (row) ids.set(input.relativePath, row.id);
      }
    });

    run(inputs);
    return ids;
  }

  reassignToScan(projectFileIds: number[], scanId: number): void {
    if (projectFileIds.length === 0) return;
    const statement = this.db.prepare(`UPDATE project_files SET scan_id = ? WHERE id = ?`);
    const run = this.db.transaction((ids: number[]) => {
      for (const id of ids) statement.run(scanId, id);
    });
    run(projectFileIds);
  }

  removeByIds(projectFileIds: number[]): number {
    if (projectFileIds.length === 0) return 0;
    const statement = this.db.prepare(`DELETE FROM project_files WHERE id = ?`);
    let removed = 0;
    const run = this.db.transaction((ids: number[]) => {
      for (const id of ids) removed += statement.run(id).changes;
    });
    run(projectFileIds);
    return removed;
  }

  countByProject(projectId: number): number {
    const row = this.db
      .prepare<[number], { count: number }>(
        `SELECT COUNT(*) AS count FROM project_files WHERE project_id = ?`,
      )
      .get(projectId);
    return row?.count ?? 0;
  }

  countsByCapability(projectId: number): ProjectFileCapabilityCounts {
    return (
      this.db
        .prepare<[number], ProjectFileCapabilityCounts>(
          `SELECT
             COUNT(*) AS total,
             COUNT(CASE WHEN analysis_status = 'eligible' THEN 1 END) AS eligible,
             COUNT(CASE WHEN analysis_status = 'text-only' THEN 1 END) AS textOnly,
             COUNT(CASE WHEN analysis_status = 'binary' THEN 1 END) AS binary,
             COUNT(CASE WHEN analysis_status = 'excluded' THEN 1 END) AS excluded,
             COUNT(CASE WHEN analysis_status = 'oversize' THEN 1 END) AS oversize,
             COUNT(CASE WHEN analysis_status = 'unreadable' THEN 1 END) AS unreadable,
             COUNT(CASE WHEN analysis_status = 'symlink' THEN 1 END) AS symlink,
             COUNT(CASE WHEN is_git_ignored = 1 THEN 1 END) AS gitIgnored,
             COUNT(CASE WHEN is_user_excluded = 1 THEN 1 END) AS userExcluded
           FROM project_files WHERE project_id = ?`,
        )
        .get(projectId) ?? {
        total: 0,
        eligible: 0,
        textOnly: 0,
        binary: 0,
        excluded: 0,
        oversize: 0,
        unreadable: 0,
        symlink: 0,
        gitIgnored: 0,
        userExcluded: 0,
      }
    );
  }
}
