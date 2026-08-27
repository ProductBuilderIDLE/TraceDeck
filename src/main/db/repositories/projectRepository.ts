import type { Db } from '../connection';
import type { Project, ProjectConfiguration } from '@shared/types';
import { DEFAULT_PROJECT_CONFIGURATION } from '@shared/types';
import { nowIso, parseJson, type ProjectRow } from '../rows';

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    lastScanAt: row.last_scan_at,
    configuration: {
      ...DEFAULT_PROJECT_CONFIGURATION,
      ...parseJson<Partial<ProjectConfiguration>>(row.configuration_json, {}),
    },
  };
}

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  list(): Project[] {
    const rows = this.db
      .prepare<[], ProjectRow>(
        `SELECT * FROM projects ORDER BY COALESCE(last_opened_at, created_at) DESC`,
      )
      .all();
    return rows.map(mapProject);
  }

  findById(id: number): Project | null {
    const row = this.db
      .prepare<[number], ProjectRow>(`SELECT * FROM projects WHERE id = ?`)
      .get(id);
    return row ? mapProject(row) : null;
  }

  findByRootPath(rootPath: string): Project | null {
    const row = this.db
      .prepare<[string], ProjectRow>(`SELECT * FROM projects WHERE root_path = ?`)
      .get(rootPath);
    return row ? mapProject(row) : null;
  }

  /** Opening an already-known folder must not create a duplicate project row. */
  createOrTouch(name: string, rootPath: string): Project {
    const existing = this.findByRootPath(rootPath);
    if (existing) {
      this.touch(existing.id);
      return this.findById(existing.id) as Project;
    }

    const timestamp = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO projects (name, root_path, created_at, last_opened_at, configuration_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(name, rootPath, timestamp, timestamp, JSON.stringify(DEFAULT_PROJECT_CONFIGURATION));

    return this.findById(Number(result.lastInsertRowid)) as Project;
  }

  touch(id: number): void {
    this.db.prepare(`UPDATE projects SET last_opened_at = ? WHERE id = ?`).run(nowIso(), id);
  }

  markScanned(id: number, scannedAt: string): void {
    this.db.prepare(`UPDATE projects SET last_scan_at = ? WHERE id = ?`).run(scannedAt, id);
  }

  updateConfiguration(id: number, configuration: ProjectConfiguration): Project | null {
    this.db
      .prepare(`UPDATE projects SET configuration_json = ? WHERE id = ?`)
      .run(JSON.stringify(configuration), id);
    return this.findById(id);
  }

  remove(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    return result.changes > 0;
  }
}
