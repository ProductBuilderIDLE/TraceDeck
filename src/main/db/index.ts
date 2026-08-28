import { closeDatabase, openDatabase, type Db } from './connection';
import { EdgeRepository } from './repositories/edgeRepository';
import { FileRepository } from './repositories/fileRepository';
import { FindingRepository } from './repositories/findingRepository';
import { ProjectFileRepository } from './repositories/projectFileRepository';
import { ProjectRepository } from './repositories/projectRepository';
import { ReportRepository } from './repositories/reportRepository';
import { RuleRepository } from './repositories/ruleRepository';
import { ScanRepository } from './repositories/scanRepository';
import { SnapshotRepository } from './repositories/snapshotRepository';
import { SymbolRepository } from './repositories/symbolRepository';

/** One handle carrying the connection and every repository bound to it. */
export class DataStore {
  readonly projects: ProjectRepository;
  readonly scans: ScanRepository;
  readonly files: FileRepository;
  readonly projectFiles: ProjectFileRepository;
  readonly symbols: SymbolRepository;
  readonly edges: EdgeRepository;
  readonly findings: FindingRepository;
  readonly rules: RuleRepository;
  readonly reports: ReportRepository;
  readonly snapshots: SnapshotRepository;

  constructor(readonly db: Db) {
    this.projects = new ProjectRepository(db);
    this.scans = new ScanRepository(db);
    this.files = new FileRepository(db);
    this.projectFiles = new ProjectFileRepository(db);
    this.symbols = new SymbolRepository(db);
    this.edges = new EdgeRepository(db);
    this.findings = new FindingRepository(db);
    this.rules = new RuleRepository(db);
    this.reports = new ReportRepository(db);
    this.snapshots = new SnapshotRepository(db);
  }

  /** Runs the callback inside a single transaction; nested calls reuse the outer one. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  close(): void {
    closeDatabase(this.db);
  }
}

export function createDataStore(filePath: string): DataStore {
  const store = new DataStore(openDatabase({ filePath }));
  // A scan interrupted by a crash or force-quit is never resumable.
  store.scans.markInterruptedScansFailed();
  return store;
}

export { openDatabase, closeDatabase };
export type { Db };
export * from './repositories/edgeRepository';
export * from './repositories/fileRepository';
export * from './repositories/findingRepository';
export * from './repositories/projectFileRepository';
export * from './repositories/ruleRepository';
export * from './repositories/symbolRepository';
