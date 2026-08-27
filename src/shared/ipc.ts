import type {
  ArchitectureRule,
  ArchitectureRuleConfiguration,
  ArchitectureRuleType,
  BlastRadiusResult,
  DashboardStats,
  EdgeType,
  FileDetail,
  Finding,
  FindingType,
  GraphPayload,
  NodeType,
  Project,
  ProjectConfiguration,
  ReportConfiguration,
  RiskScore,
  SavedReport,
  Scan,
  ScanProgress,
  SearchResult,
  SourceDocument,
} from './types';
import type { ThemeId } from './theme';

/**
 * Every handler returns this envelope. Failures are converted to a plain message in the
 * main process so renderer code never receives a stack trace or an absolute internal path.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface OpenProjectResult {
  project: Project | null;
  /** Null when the user cancelled the native dialog. */
  cancelled: boolean;
}

export interface StartScanRequest {
  projectId: number;
  fullRescan: boolean;
}

export interface GraphQueryRequest {
  projectId: number;
  /** When set, only the subgraph within `focusDepth` hops of this node is returned. */
  focusNodeId?: string;
  focusDepth?: number;
  nodeTypes?: NodeType[];
  edgeTypes?: EdgeType[];
  /** Relative folder prefix filter, e.g. "src/components". */
  folderPrefix?: string;
  includeUnresolved?: boolean;
  nodeLimit?: number;
}

export interface BlastRadiusRequest {
  projectId: number;
  nodeId: string;
  maxDepth: number;
  edgeTypes?: EdgeType[];
  includeUnresolved?: boolean;
}

export interface SearchRequest {
  projectId: number;
  query: string;
  types?: NodeType[];
  limit?: number;
}

export interface FindingsRequest {
  projectId: number;
  findingType?: FindingType;
  includeDismissed?: boolean;
}

export interface DismissFindingRequest {
  findingId: number;
  dismissed: boolean;
}

export interface UpsertRuleRequest {
  id?: number;
  projectId: number;
  name: string;
  enabled: boolean;
  ruleType: ArchitectureRuleType;
  sourcePattern: string;
  targetPattern: string;
  configuration: ArchitectureRuleConfiguration;
}

export interface ExportReportRequest {
  projectId: number;
  configuration: ReportConfiguration;
}

export interface ExportReportResult {
  filePath: string;
  cancelled: boolean;
}

export interface RiskScoreRequest {
  projectId: number;
  nodeId: string;
}

export interface FileDetailRequest {
  projectId: number;
  nodeId: string;
}

export interface UpdateProjectConfigRequest {
  projectId: number;
  configuration: ProjectConfiguration;
}

/**
 * The single source of truth for the IPC surface. Adding a channel here and implementing
 * the handler is the only supported way to widen what the renderer can reach.
 */
export interface IpcContract {
  'project:list': { request: void; response: Project[] };
  'project:open-dialog': { request: void; response: OpenProjectResult };
  'project:select': { request: { projectId: number }; response: Project };
  'project:remove': { request: { projectId: number }; response: { removed: boolean } };
  'project:update-config': { request: UpdateProjectConfigRequest; response: Project };

  'scan:start': { request: StartScanRequest; response: { scanId: number } };
  'scan:cancel': { request: { projectId: number }; response: { cancelled: boolean } };
  'scan:latest': { request: { projectId: number }; response: Scan | null };

  'dashboard:stats': { request: { projectId: number }; response: DashboardStats };

  'graph:query': { request: GraphQueryRequest; response: GraphPayload };
  'graph:blast-radius': { request: BlastRadiusRequest; response: BlastRadiusResult };
  'graph:risk-score': { request: RiskScoreRequest; response: RiskScore };
  'graph:file-detail': { request: FileDetailRequest; response: FileDetail };

  'search:query': { request: SearchRequest; response: SearchResult[] };

  'findings:list': { request: FindingsRequest; response: Finding[] };
  'findings:dismiss': { request: DismissFindingRequest; response: { updated: boolean } };

  'rules:list': { request: { projectId: number }; response: ArchitectureRule[] };
  'rules:upsert': { request: UpsertRuleRequest; response: ArchitectureRule };
  'rules:delete': { request: { ruleId: number }; response: { deleted: boolean } };
  'rules:evaluate': { request: { projectId: number }; response: { violationCount: number } };

  'reports:list': { request: { projectId: number }; response: SavedReport[] };
  'reports:export': { request: ExportReportRequest; response: ExportReportResult };
  'reports:delete': { request: { reportId: number }; response: { deleted: boolean } };

  'system:open-path': { request: { projectId: number; relativePath: string }; response: void };
  'system:reveal-path': { request: { projectId: number; relativePath: string }; response: void };
  'system:app-info': {
    request: void;
    response: { version: string; electron: string; databasePath: string };
  };
  'system:set-theme': { request: { theme: ThemeId }; response: void };
  'source:read': {
    request: { projectId: number; relativePath: string };
    response: SourceDocument;
  };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

export const IPC_CHANNELS = [
  'project:list',
  'project:open-dialog',
  'project:select',
  'project:remove',
  'project:update-config',
  'scan:start',
  'scan:cancel',
  'scan:latest',
  'dashboard:stats',
  'graph:query',
  'graph:blast-radius',
  'graph:risk-score',
  'graph:file-detail',
  'search:query',
  'findings:list',
  'findings:dismiss',
  'rules:list',
  'rules:upsert',
  'rules:delete',
  'rules:evaluate',
  'reports:list',
  'reports:export',
  'reports:delete',
  'system:open-path',
  'system:reveal-path',
  'system:app-info',
  'system:set-theme',
  'source:read',
] as const satisfies readonly IpcChannel[];

/** Main -> renderer push events. These are one-way and carry no privileged handles. */
export const SCAN_PROGRESS_EVENT = 'scan:progress';

export interface TraceDeckApi {
  invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>>;
  onScanProgress(listener: (progress: ScanProgress) => void): () => void;
}
