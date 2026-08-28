import type { Database as BetterSqlite3Database } from 'better-sqlite3';

type Db = BetterSqlite3Database;

export interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

const INITIAL_SCHEMA = `
CREATE TABLE projects (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  root_path          TEXT    NOT NULL UNIQUE,
  created_at         TEXT    NOT NULL,
  last_opened_at     TEXT,
  last_scan_at       TEXT,
  configuration_json TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at   TEXT    NOT NULL,
  completed_at TEXT,
  status       TEXT    NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  git_commit   TEXT,
  total_files  INTEGER NOT NULL DEFAULT 0,
  parsed_files INTEGER NOT NULL DEFAULT 0,
  error_count  INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT
);
CREATE INDEX idx_scans_project ON scans(project_id, started_at DESC);

CREATE TABLE files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relative_path  TEXT    NOT NULL,
  absolute_path  TEXT    NOT NULL,
  extension      TEXT    NOT NULL,
  content_hash   TEXT    NOT NULL,
  modified_at    TEXT    NOT NULL,
  is_entry_point INTEGER NOT NULL DEFAULT 0,
  scan_id        INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  UNIQUE (project_id, relative_path)
);
CREATE INDEX idx_files_project ON files(project_id);
CREATE INDEX idx_files_scan ON files(scan_id);

CREATE TABLE symbols (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name              TEXT    NOT NULL,
  kind              TEXT    NOT NULL,
  is_exported       INTEGER NOT NULL DEFAULT 0,
  is_default_export INTEGER NOT NULL DEFAULT 0,
  start_line        INTEGER NOT NULL DEFAULT 0,
  end_line          INTEGER NOT NULL DEFAULT 0,
  metadata_json     TEXT    NOT NULL DEFAULT '{}',
  scan_id           INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE
);
CREATE INDEX idx_symbols_project ON symbols(project_id);
CREATE INDEX idx_symbols_file ON symbols(file_id);
CREATE INDEX idx_symbols_name ON symbols(project_id, name);
CREATE INDEX idx_symbols_exported ON symbols(project_id, is_exported);

CREATE TABLE graph_edges (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_node_type TEXT    NOT NULL,
  from_node_id   TEXT    NOT NULL,
  to_node_type   TEXT    NOT NULL,
  to_node_id     TEXT    NOT NULL,
  edge_type      TEXT    NOT NULL,
  source_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  source_line    INTEGER,
  metadata_json  TEXT    NOT NULL DEFAULT '{}',
  scan_id        INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE
);
CREATE INDEX idx_edges_project ON graph_edges(project_id);
CREATE INDEX idx_edges_from ON graph_edges(project_id, from_node_id);
CREATE INDEX idx_edges_to ON graph_edges(project_id, to_node_id);
CREATE INDEX idx_edges_source_file ON graph_edges(source_file_id);
CREATE INDEX idx_edges_type ON graph_edges(project_id, edge_type);

CREATE TABLE analysis_findings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scan_id               INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  finding_type          TEXT    NOT NULL,
  severity              TEXT    NOT NULL,
  title                 TEXT    NOT NULL,
  description           TEXT    NOT NULL DEFAULT '',
  related_node_ids_json TEXT    NOT NULL DEFAULT '[]',
  details_json          TEXT    NOT NULL DEFAULT '{}',
  fingerprint           TEXT    NOT NULL DEFAULT '',
  created_at            TEXT    NOT NULL,
  dismissed_at          TEXT
);
CREATE INDEX idx_findings_project ON analysis_findings(project_id, finding_type);
CREATE INDEX idx_findings_fingerprint ON analysis_findings(project_id, fingerprint);
CREATE INDEX idx_findings_scan ON analysis_findings(scan_id);

CREATE TABLE architecture_rules (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  rule_type          TEXT    NOT NULL,
  source_pattern     TEXT    NOT NULL,
  target_pattern     TEXT    NOT NULL,
  configuration_json TEXT    NOT NULL DEFAULT '{}',
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);
CREATE INDEX idx_rules_project ON architecture_rules(project_id);

CREATE TABLE saved_reports (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL,
  report_type        TEXT    NOT NULL,
  configuration_json TEXT    NOT NULL DEFAULT '{}',
  created_at         TEXT    NOT NULL
);
CREATE INDEX idx_reports_project ON saved_reports(project_id);

/*
 * A dismissal must outlive the scan whose finding it was attached to, otherwise every rescan
 * resurrects everything the user already reviewed. Dismissals are therefore keyed by a stable
 * content fingerprint rather than by finding id.
 */
CREATE TABLE finding_dismissals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  finding_type TEXT    NOT NULL,
  fingerprint  TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  UNIQUE (project_id, finding_type, fingerprint)
);
CREATE INDEX idx_dismissals_project ON finding_dismissals(project_id, finding_type);
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(INITIAL_SCHEMA);
    },
  },
  {
    version: 2,
    name: 'project-file-inventory',
    up: (db) => {
      db.exec(`
        CREATE TABLE project_files (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          relative_path    TEXT    NOT NULL,
          absolute_path    TEXT    NOT NULL,
          scan_id          INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
          entry_kind       TEXT    NOT NULL CHECK (entry_kind IN ('regular','symlink')),
          extension        TEXT    NOT NULL,
          size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
          modified_at      TEXT    NOT NULL,
          content_kind     TEXT    NOT NULL CHECK (content_kind IN ('text','binary','unknown')),
          encoding         TEXT,
          content_hash     TEXT,
          is_git_ignored   INTEGER NOT NULL DEFAULT 0 CHECK (is_git_ignored IN (0,1)),
          gitignore_rule   TEXT,
          is_user_excluded INTEGER NOT NULL DEFAULT 0 CHECK (is_user_excluded IN (0,1)),
          analysis_status  TEXT    NOT NULL CHECK (analysis_status IN
            ('eligible','text-only','binary','excluded','oversize','unreadable','symlink')),
          analysis_reason  TEXT    NOT NULL,
          UNIQUE (project_id, relative_path)
        );
        CREATE INDEX idx_project_files_project ON project_files(project_id, relative_path);
        CREATE INDEX idx_project_files_scan ON project_files(scan_id);
        CREATE INDEX idx_project_files_status ON project_files(project_id, analysis_status);
      `);
    },
  },
  {
    version: 3,
    name: 'scan-snapshots',
    up: (db) => {
      db.exec(`
        CREATE TABLE scan_snapshots (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          scan_id            INTEGER NOT NULL,
          created_at         TEXT    NOT NULL,
          fingerprints_json  TEXT    NOT NULL
        );
        CREATE INDEX idx_snapshots_project ON scan_snapshots(project_id, id DESC);
      `);
    },
  },
];

export function currentSchemaVersion(db: Db): number {
  const result = db.pragma('user_version', { simple: true });
  return typeof result === 'number' ? result : 0;
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

/**
 * Applies every migration newer than the database's recorded version, each inside its own
 * transaction. A failing migration rolls back and aborts the run, leaving the database at the
 * last version that applied cleanly rather than in a half-migrated state.
 */
export function runMigrations(db: Db): number {
  const startingVersion = currentSchemaVersion(db);

  if (startingVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${startingVersion} is newer than this build supports ` +
        `(${LATEST_SCHEMA_VERSION}). Update TraceDeck to open it.`,
    );
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > startingVersion).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      // pragma cannot be parameterised, so the value is an integer from a literal list above.
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      apply();
    } catch (error) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return currentSchemaVersion(db);
}
