import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  /** Absolute path to the database file, or ':memory:' for tests. */
  filePath: string;
  readonly?: boolean;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly version: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Opens the local database and brings its schema up to date.
 *
 * WAL is enabled because a scan writes tens of thousands of rows while the UI concurrently
 * reads dashboard counts; without it those readers block behind the writer.
 */
export function openDatabase({ filePath, readonly = false }: OpenDatabaseOptions): Db {
  const db = new Database(filePath, { readonly });

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Bulk edge inserts churn temporary b-trees; keeping them in memory is a large win.
  db.pragma('temp_store = MEMORY');

  if (!readonly) {
    runMigrations(db);
  }

  return db;
}

export function closeDatabase(db: Db): void {
  try {
    // Collapses the WAL back into the main file so the on-disk database is self-contained.
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // A checkpoint failure must not prevent a clean shutdown.
  }
  db.close();
}
