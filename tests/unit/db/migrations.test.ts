import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  currentSchemaVersion,
  runMigrations,
} from '@main/db/migrations';
import { openDatabase } from '@main/db/connection';

function tableNames(db: Database.Database): string[] {
  return db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

describe('schema migrations', () => {
  it('brings a fresh database to the latest version', () => {
    const db = new Database(':memory:');
    expect(currentSchemaVersion(db)).toBe(0);

    const version = runMigrations(db);

    expect(version).toBe(LATEST_SCHEMA_VERSION);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('creates every table the data model requires', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    expect(tableNames(db)).toEqual([
      'analysis_findings',
      'architecture_rules',
      'files',
      'finding_dismissals',
      'graph_edges',
      'project_files',
      'projects',
      'saved_reports',
      'scans',
      'symbols',
    ]);
  });

  it('is idempotent when run again on an up-to-date database', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const before = tableNames(db);

    expect(() => runMigrations(db)).not.toThrow();
    expect(tableNames(db)).toEqual(before);
  });

  it('refuses to open a database newer than the build supports', () => {
    const db = new Database(':memory:');
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 5}`);

    expect(() => runMigrations(db)).toThrow(/newer than this build supports/);
  });

  it('rolls a failing migration back and reports which one failed', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const versionBefore = currentSchemaVersion(db);

    const broken = {
      version: LATEST_SCHEMA_VERSION + 1,
      name: 'intentionally-broken',
      up: (target: Database.Database) => {
        target.exec('CREATE TABLE ok_so_far (id INTEGER)');
        target.exec('THIS IS NOT VALID SQL');
      },
    };
    MIGRATIONS.push(broken);

    try {
      expect(() => runMigrations(db)).toThrow(/intentionally-broken/);
      // The transaction rolled back, so the partial table must not exist and the recorded
      // version must still be the last one that applied cleanly.
      expect(tableNames(db)).not.toContain('ok_so_far');
      expect(currentSchemaVersion(db)).toBe(versionBefore);
    } finally {
      MIGRATIONS.pop();
    }
  });

  it('enables foreign keys and WAL through openDatabase', () => {
    const db = openDatabase({ filePath: ':memory:' });

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });
});
