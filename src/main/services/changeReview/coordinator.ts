import { join } from 'node:path';
import type {
  ChangeReviewResult,
  ChangeReviewSummary,
  ReviewFileDiff,
  ReviewOperationPhase,
  ReviewSection,
  ReviewStatus,
} from '@shared/changeReview';
import {
  DEFAULT_MAX_TRAVERSAL_DEPTH,
  MAX_REVIEW_DETAIL_ITEMS,
  MAX_TRAVERSAL_DEPTH,
} from '@shared/constants';
import type { ArchitectureRule, Project, ScanProgress } from '@shared/types';
import { compareReviewSnapshots } from '../../analysis/algorithms/reviewComparator';
import { runScan, ScanCancelledError } from '../../analysis/scanner';
import {
  createDataStore,
  type ChangeReviewRecord,
  type DataStore,
} from '../../db';
import type { ProjectOperationLease, ProjectOperationRegistry } from '../projectOperations';
import { resolveWithinProject } from '../../utils/paths';
import { canonicalSha256, compareCodePoints } from './canonical';
import { captureWorkingTree, readReviewDiff, type CapturedWorkingTree } from './gitStatus';
import {
  createReviewTempRoot,
  materializeHeadTree,
  removeVerifiedReviewTemp,
  type MaterializedHead,
  type ReviewTempRoot,
} from './materializer';
import { extractReviewSnapshot, type ReviewSnapshot } from './snapshot';

const MAX_STATUS_MESSAGE_LENGTH = 240;
const MAX_TERMINAL_PROJECTS = 100;

const REVIEW_SECTIONS: ReviewSection[] = [
  'files',
  'edges',
  'findings',
  'architecture-violations',
  'cycles',
  'reachable-exports',
  'affected-files',
  'candidate-tests',
  'no-known-tests',
  'limitations',
];

export interface ChangeReviewCoordinatorDependencies {
  traceDeckVersion: string;
  runScan: typeof runScan;
  captureWorkingTree: typeof captureWorkingTree;
  readReviewDiff: typeof readReviewDiff;
  createReviewTempRoot: typeof createReviewTempRoot;
  materializeHeadTree: typeof materializeHeadTree;
  removeVerifiedReviewTemp: typeof removeVerifiedReviewTemp;
  extractReviewSnapshot: typeof extractReviewSnapshot;
  compareReviewSnapshots: typeof compareReviewSnapshots;
  createDataStore: typeof createDataStore;
}

type LastOutcome = NonNullable<ReviewStatus['lastOutcome']>;
type ActiveReviewStatus = NonNullable<ReviewStatus['activeOperation']>;
type RepositoryCacheEntry = Pick<ReviewStatus, 'repositoryState' | 'baseCommit' | 'baseTreeId'>;

export class ChangeReviewCoordinatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ChangeReviewCoordinatorError';
  }
}

function coordinatorError(code: string): ChangeReviewCoordinatorError {
  const messages: Record<string, string> = {
    NOT_FOUND: 'That project no longer exists.',
    REVIEW_NOT_FOUND: 'That change review item no longer exists.',
    NOT_A_GIT_REPO: 'The selected project is not a Git repository.',
    HEAD_UNBORN: 'The Git repository does not have a commit yet.',
    SCAN_IN_PROGRESS: 'A scan is already running for this project.',
    REVIEW_IN_PROGRESS: 'A change review is already running for this project.',
    REVIEW_CANCELLED: 'Change review cancelled.',
    REVIEW_STALE: 'The project changed during the review. The previous review was preserved.',
    REVIEW_GIT_TIMEOUT: 'Git did not finish in time while preparing the change review.',
    INVALID_GIT_PATH_ENCODING: 'A Git path cannot be reviewed safely.',
    REVIEW_GIT_FAILED: 'Git review data could not be read.',
    REVIEW_INCOMPATIBLE: 'The baseline and target review snapshots are not comparable.',
    REVIEW_FAILED: 'The change review could not be completed.',
  };
  return new ChangeReviewCoordinatorError(code, messages[code] ?? messages.REVIEW_FAILED as string);
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function normalizeFailure(error: unknown, lease: ProjectOperationLease): ChangeReviewCoordinatorError {
  if (lease.cancellationRequested || error instanceof ScanCancelledError) {
    return coordinatorError('REVIEW_CANCELLED');
  }
  if (error instanceof ChangeReviewCoordinatorError) return error;

  const code = errorCode(error);
  if (code === 'REVIEW_CANCELLED') return coordinatorError('REVIEW_CANCELLED');
  if (
    code === 'NOT_A_GIT_REPO'
    || code === 'HEAD_UNBORN'
    || code === 'REVIEW_GIT_TIMEOUT'
    || code === 'INVALID_GIT_PATH_ENCODING'
    || code === 'REVIEW_GIT_FAILED'
    || code === 'REVIEW_INCOMPATIBLE'
  ) {
    return coordinatorError(code);
  }
  return coordinatorError('REVIEW_FAILED');
}

function terminalFor(error: ChangeReviewCoordinatorError, operationId: string): LastOutcome {
  if (error.code === 'REVIEW_CANCELLED') {
    return { operationId, status: 'cancelled', code: error.code, message: error.message };
  }
  if (error.code === 'REVIEW_STALE') {
    return { operationId, status: 'stale', code: error.code, message: error.message };
  }
  return { operationId, status: 'failed', code: error.code, message: error.message };
}

function clampDepth(value: number): number {
  const finite = Number.isFinite(value) ? Math.trunc(value) : DEFAULT_MAX_TRAVERSAL_DEPTH;
  return Math.max(1, Math.min(MAX_TRAVERSAL_DEPTH, finite));
}

function boundedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function boundedMessage(value: string): string {
  const withoutAbsolutePaths = value
    .replace(/[A-Za-z]:[\\/][^\s"'(),]*/g, '<absolute path>')
    .replace(/(^|[\s"'(])\/(?:[^\s"'(),]+\/?)+/g, '$1<absolute path>');
  return withoutAbsolutePaths.slice(0, MAX_STATUS_MESSAGE_LENGTH);
}

function cloneProject(project: Project): Project {
  return {
    ...project,
    configuration: {
      ...project.configuration,
      excludePatterns: [...project.configuration.excludePatterns],
      entryPoints: [...project.configuration.entryPoints],
      unusedExportExclusions: [...project.configuration.unusedExportExclusions],
    },
  };
}

function cloneRules(rules: readonly ArchitectureRule[]): ArchitectureRule[] {
  return rules.map((rule) => ({
    ...rule,
    configuration: {
      ...rule.configuration,
      exceptions: [...rule.configuration.exceptions],
    },
  }));
}

function configurationSignature(project: Project, rules: readonly ArchitectureRule[]): string {
  const orderedRules = rules
    .map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      ruleType: rule.ruleType,
      sourcePattern: rule.sourcePattern,
      targetPattern: rule.targetPattern,
      configuration: rule.configuration,
    }))
    .sort((left, right) => left.id - right.id || compareCodePoints(left.name, right.name));
  return canonicalSha256({
    rootPath: project.rootPath,
    configuration: project.configuration,
    enabledRules: orderedRules,
  });
}

function categoryAvailability(): Record<ReviewSection, boolean> {
  return Object.fromEntries(REVIEW_SECTIONS.map((section) => [section, true])) as Record<
    ReviewSection,
    boolean
  >;
}

function insertBaselineRules(
  store: DataStore,
  projectId: number,
  rules: readonly ArchitectureRule[],
): void {
  const insert = store.db.prepare(
    `INSERT INTO architecture_rules
       (id, project_id, name, enabled, rule_type, source_pattern, target_pattern,
        configuration_json, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  store.transaction(() => {
    for (const rule of rules) {
      insert.run(
        rule.id,
        projectId,
        rule.name,
        rule.ruleType,
        rule.sourcePattern,
        rule.targetPattern,
        JSON.stringify(rule.configuration),
        rule.createdAt,
        rule.updatedAt,
      );
    }
  });
}

function mergeMaterializerLimitations(
  snapshot: ReviewSnapshot,
  materialized: MaterializedHead,
): ReviewSnapshot {
  const limitations = new Map(snapshot.limitations.map((limitation) => [
    limitation.stableKey,
    limitation,
  ]));
  for (const limitation of materialized.limitations) {
    limitations.set(limitation.stableKey, limitation);
  }
  return {
    ...snapshot,
    limitations: [...limitations.values()].sort((left, right) => (
      compareCodePoints(left.stableKey, right.stableKey)
    )),
  };
}

function assertNotCancelled(lease: ProjectOperationLease): void {
  if (lease.cancellationRequested) throw coordinatorError('REVIEW_CANCELLED');
}

function assertUnchanged(condition: boolean): void {
  if (!condition) throw coordinatorError('REVIEW_STALE');
}

export function defaultChangeReviewCoordinatorDependencies(
  traceDeckVersion: string,
): ChangeReviewCoordinatorDependencies {
  return {
    traceDeckVersion,
    runScan,
    captureWorkingTree,
    readReviewDiff,
    createReviewTempRoot,
    materializeHeadTree,
    removeVerifiedReviewTemp,
    extractReviewSnapshot,
    compareReviewSnapshots,
    createDataStore,
  };
}

/** Runs one point-in-time working-tree review while retaining only a fully validated result. */
export class ChangeReviewCoordinator {
  private readonly activeStatuses = new Map<number, ActiveReviewStatus>();
  private readonly lastOutcomes = new Map<number, LastOutcome>();
  private readonly repositoryCache = new Map<number, RepositoryCacheEntry>();

  constructor(
    private readonly store: DataStore,
    private readonly operations: ProjectOperationRegistry,
    private readonly dependencies: ChangeReviewCoordinatorDependencies,
  ) {}

  start(projectId: number, maxDepth: number): { operationId: string } {
    const lease = this.acquireLease(projectId, true);
    void this.runWithLease(projectId, clampDepth(maxDepth), lease).catch(() => undefined);
    return { operationId: lease.operationId };
  }

  async runNow(projectId: number, maxDepth: number): Promise<ChangeReviewRecord> {
    const lease = this.acquireLease(projectId, false);
    return this.runWithLease(projectId, clampDepth(maxDepth), lease);
  }

  cancel(projectId: number, operationId: string): boolean {
    const active = this.operations.active(projectId);
    if (active?.kind !== 'review' || active.operationId !== operationId) return false;
    return this.operations.cancel(projectId, operationId);
  }

  async status(projectId: number): Promise<ReviewStatus> {
    const project = this.store.projects.findById(projectId);
    if (!project) throw coordinatorError('NOT_FOUND');

    let capture: CapturedWorkingTree | null = null;
    let repositoryState: ReviewStatus['repositoryState'] = 'ready';
    try {
      capture = await this.dependencies.captureWorkingTree(project.rootPath);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'NOT_A_GIT_REPO') repositoryState = 'not-git';
      else if (code === 'HEAD_UNBORN') repositoryState = 'unborn-head';
      else throw normalizeFailure(error, this.statusLease(projectId));
    }

    const baseCommit = capture?.head.fullCommit ?? null;
    const baseTreeId = capture?.head.treeId ?? null;
    this.repositoryCache.set(projectId, { repositoryState, baseCommit, baseTreeId });

    const latest = this.store.changeReviews.latestForProject(projectId);
    let latestReview: ReviewStatus['latestReview'] = null;
    if (latest) {
      if (!latest.compatible || !latest.result || !latest.summary) {
        latestReview = { reviewId: latest.id, freshness: 'incompatible', staleReasons: [] };
      } else {
        const staleReasons: string[] = [];
        if (repositoryState === 'not-git') staleReasons.push('NOT_A_GIT_REPO');
        else if (repositoryState === 'unborn-head') staleReasons.push('HEAD_UNBORN');
        else if (capture) {
          if (capture.head.fullCommit !== latest.baseCommit) staleReasons.push('BASE_COMMIT_CHANGED');
          if (capture.head.treeId !== latest.baseTreeId) staleReasons.push('BASE_TREE_CHANGED');
          if (capture.fingerprint !== latest.workingTreeFingerprint) {
            staleReasons.push('WORKING_TREE_CHANGED');
          }
          try {
            const currentSnapshot = this.dependencies.extractReviewSnapshot({
              store: this.store,
              project,
              side: 'target',
              baseCommit: capture.head.fullCommit,
              baseTreeId: capture.head.treeId,
              workingTreeFingerprint: capture.fingerprint,
              traceDeckVersion: this.dependencies.traceDeckVersion,
              extraInventory: [],
            });
            if (currentSnapshot.userConfigurationFingerprint !== latest.userConfigurationFingerprint) {
              staleReasons.push('USER_CONFIGURATION_CHANGED');
            }
            if (
              currentSnapshot.effectiveBaselineFingerprint
              !== latest.effectiveBaselineFingerprint
            ) {
              staleReasons.push('EFFECTIVE_BASELINE_CHANGED');
            }
          } catch {
            staleReasons.push('CONFIGURATION_UNAVAILABLE');
          }
        }
        latestReview = {
          reviewId: latest.id,
          freshness: staleReasons.length === 0 ? 'current' : 'stale',
          staleReasons,
        };
      }
    }

    const operation = this.operations.active(projectId);
    const active = this.activeStatuses.get(projectId);
    const activeOperation = operation?.kind === 'review'
      && active?.operationId === operation.operationId
      ? { ...active, cancellationRequested: operation.cancellationRequested }
      : null;

    return {
      projectId,
      repositoryState,
      baseCommit,
      baseTreeId,
      branchName: capture?.head.branchName ?? null,
      gitChanges: capture?.changes ?? [],
      latestReview,
      activeOperation,
      lastOutcome: this.lastOutcomes.get(projectId) ?? null,
    };
  }

  async summary(projectId: number): Promise<ChangeReviewSummary | null> {
    return this.store.changeReviews.latestForProject(projectId)?.summary ?? null;
  }

  /** Reads a diff only when the retained review still describes the exact current worktree. */
  async fileDiff(record: ChangeReviewRecord, relativePath: string): Promise<ReviewFileDiff> {
    if (!record.compatible || !record.result) throw coordinatorError('REVIEW_INCOMPATIBLE');

    const status = await this.status(record.projectId);
    if (
      status.latestReview?.reviewId !== record.id
      || status.latestReview.freshness !== 'current'
      || status.baseCommit === null
      || status.baseCommit !== record.baseCommit
    ) {
      throw coordinatorError('REVIEW_STALE');
    }

    const change = record.result.fileChanges.find((candidate) => (
      candidate.relativePath === relativePath
      || candidate.oldPath === relativePath
      || candidate.copiedFrom === relativePath
    ));
    if (!change) throw coordinatorError('REVIEW_NOT_FOUND');

    const project = this.store.projects.findById(record.projectId);
    if (!project) throw coordinatorError('NOT_FOUND');
    resolveWithinProject(project.rootPath, relativePath);
    try {
      return await this.dependencies.readReviewDiff({
        rootPath: project.rootPath,
        baseCommit: record.baseCommit,
        change,
      });
    } catch (error) {
      throw normalizeFailure(error, this.statusLease(record.projectId));
    }
  }

  private acquireLease(projectId: number, useRepositoryCache: boolean): ProjectOperationLease {
    if (!this.store.projects.findById(projectId)) throw coordinatorError('NOT_FOUND');
    if (useRepositoryCache) {
      const cached = this.repositoryCache.get(projectId);
      if (cached?.repositoryState === 'not-git') throw coordinatorError('NOT_A_GIT_REPO');
      if (cached?.repositoryState === 'unborn-head') throw coordinatorError('HEAD_UNBORN');
    }

    const existing = this.operations.active(projectId);
    if (existing) {
      throw coordinatorError(existing.kind === 'scan' ? 'SCAN_IN_PROGRESS' : 'REVIEW_IN_PROGRESS');
    }
    const lease = this.operations.acquire(projectId, 'review');
    if (!lease) {
      const competing = this.operations.active(projectId);
      throw coordinatorError(competing?.kind === 'scan' ? 'SCAN_IN_PROGRESS' : 'REVIEW_IN_PROGRESS');
    }
    this.activeStatuses.set(projectId, {
      operationId: lease.operationId,
      phase: 'capturing',
      processed: 0,
      total: 0,
      message: 'Capturing repository state…',
      cancellationRequested: false,
    });
    return lease;
  }

  private statusLease(projectId: number): ProjectOperationLease {
    return {
      projectId,
      kind: 'review',
      operationId: '',
      cancellationRequested: false,
      workingTreeDirty: false,
      scanSignal: { cancelled: false },
      abortController: new AbortController(),
      markWorkingTreeDirty: () => undefined,
      consumeWatcherDirty: () => false,
      release: () => undefined,
    };
  }

  private setPhase(
    projectId: number,
    lease: ProjectOperationLease,
    phase: ReviewOperationPhase,
    progress: Partial<Pick<ScanProgress, 'processed' | 'total' | 'message'>> = {},
  ): void {
    const current = this.activeStatuses.get(projectId);
    if (!current || current.operationId !== lease.operationId) return;
    this.activeStatuses.set(projectId, {
      operationId: lease.operationId,
      phase,
      processed: boundedCount(progress.processed ?? 0),
      total: boundedCount(progress.total ?? 0),
      message: boundedMessage(progress.message ?? current.message),
      cancellationRequested: lease.cancellationRequested,
    });
  }

  private setLastOutcome(projectId: number, outcome: LastOutcome): void {
    this.lastOutcomes.delete(projectId);
    this.lastOutcomes.set(projectId, {
      ...outcome,
      message: boundedMessage(outcome.message),
    });
    while (this.lastOutcomes.size > MAX_TERMINAL_PROJECTS) {
      const oldestProject = this.lastOutcomes.keys().next().value as number | undefined;
      if (oldestProject === undefined) break;
      this.lastOutcomes.delete(oldestProject);
    }
  }

  private progressReporter(
    projectId: number,
    lease: ProjectOperationLease,
    phase: 'refreshing-target' | 'analyzing-baseline',
  ): (progress: Omit<ScanProgress, 'scanId'>) => void {
    return (progress) => {
      this.setPhase(projectId, lease, phase, progress);
    };
  }

  private async runWithLease(
    projectId: number,
    maxDepth: number,
    lease: ProjectOperationLease,
  ): Promise<ChangeReviewRecord> {
    let temp: ReviewTempRoot | null = null;
    let baselineStore: DataStore | null = null;
    let outcome: LastOutcome | null = null;

    try {
      const projectValue = this.store.projects.findById(projectId);
      if (!projectValue) throw coordinatorError('NOT_FOUND');
      const project = cloneProject(projectValue);
      const rules = cloneRules(this.store.rules.listEnabled(projectId));
      const capturedConfiguration = configurationSignature(project, rules);

      this.setPhase(projectId, lease, 'capturing', { message: 'Capturing repository state…' });
      const captured = await this.dependencies.captureWorkingTree(
        project.rootPath,
        lease.abortController.signal,
      );
      this.repositoryCache.set(projectId, {
        repositoryState: 'ready',
        baseCommit: captured.head.fullCommit,
        baseTreeId: captured.head.treeId,
      });
      assertNotCancelled(lease);

      this.setPhase(projectId, lease, 'refreshing-target', {
        message: 'Refreshing the working tree analysis…',
      });
      await this.dependencies.runScan(this.store, {
        project,
        fullRescan: false,
        signal: lease.scanSignal,
        onProgress: this.progressReporter(projectId, lease, 'refreshing-target'),
      });
      assertNotCancelled(lease);

      const targetProject = this.store.projects.findById(projectId);
      assertUnchanged(targetProject !== null);
      const currentRules = this.store.rules.listEnabled(projectId);
      assertUnchanged(
        configurationSignature(targetProject as Project, currentRules) === capturedConfiguration,
      );
      const target = this.dependencies.extractReviewSnapshot({
        store: this.store,
        project,
        side: 'target',
        baseCommit: captured.head.fullCommit,
        baseTreeId: captured.head.treeId,
        workingTreeFingerprint: captured.fingerprint,
        traceDeckVersion: this.dependencies.traceDeckVersion,
        extraInventory: [],
      });

      this.setPhase(projectId, lease, 'materializing-baseline', {
        message: 'Creating the isolated HEAD baseline…',
      });
      temp = await this.dependencies.createReviewTempRoot(this.dependencies.traceDeckVersion);
      const materialized = await this.dependencies.materializeHeadTree({
        projectRoot: project.rootPath,
        commit: captured.head.fullCommit,
        treeId: captured.head.treeId,
        temp,
        signal: lease.abortController.signal,
      });
      assertNotCancelled(lease);

      baselineStore = this.dependencies.createDataStore(join(temp.statePath, 'baseline.sqlite'));
      let baselineProject = baselineStore.projects.createOrTouch(project.name, temp.treePath);
      baselineProject = baselineStore.projects.updateConfiguration(baselineProject.id, {
        ...project.configuration,
        excludePatterns: [...project.configuration.excludePatterns],
        entryPoints: [...project.configuration.entryPoints],
        unusedExportExclusions: [...project.configuration.unusedExportExclusions],
        typeCheck: false,
      }) as Project;
      insertBaselineRules(baselineStore, baselineProject.id, rules);

      this.setPhase(projectId, lease, 'analyzing-baseline', {
        message: 'Analyzing the isolated HEAD baseline…',
      });
      await this.dependencies.runScan(baselineStore, {
        project: baselineProject,
        fullRescan: true,
        signal: lease.scanSignal,
        onProgress: this.progressReporter(projectId, lease, 'analyzing-baseline'),
      });
      assertNotCancelled(lease);

      let baseline = this.dependencies.extractReviewSnapshot({
        store: baselineStore,
        project: baselineProject,
        side: 'baseline',
        baseCommit: captured.head.fullCommit,
        baseTreeId: captured.head.treeId,
        workingTreeFingerprint: captured.fingerprint,
        traceDeckVersion: this.dependencies.traceDeckVersion,
        extraInventory: materialized.inventoryEvidence,
      });
      baseline = mergeMaterializerLimitations(baseline, materialized);
      baseline = { ...baseline, userConfigurationFingerprint: target.userConfigurationFingerprint };
      assertUnchanged(
        baseline.effectiveBaselineFingerprint === target.effectiveBaselineFingerprint,
      );

      baselineStore.close();
      baselineStore = null;

      this.setPhase(projectId, lease, 'comparing', { message: 'Comparing structural evidence…' });
      const result = this.dependencies.compareReviewSnapshots(
        baseline,
        target,
        captured.changes,
        { maxDepth, maxRetained: MAX_REVIEW_DETAIL_ITEMS, signal: lease.scanSignal },
      );
      assertNotCancelled(lease);

      this.setPhase(projectId, lease, 'validating', { message: 'Validating review freshness…' });
      assertUnchanged(!lease.workingTreeDirty);
      const finalProject = this.store.projects.findById(projectId);
      assertUnchanged(finalProject !== null);
      const finalRules = this.store.rules.listEnabled(projectId);
      assertUnchanged(
        configurationSignature(finalProject as Project, finalRules) === capturedConfiguration,
      );
      const finalCapture = await this.dependencies.captureWorkingTree(
        project.rootPath,
        lease.abortController.signal,
      );
      assertNotCancelled(lease);
      assertUnchanged(finalCapture.head.fullCommit === captured.head.fullCommit);
      assertUnchanged(finalCapture.head.treeId === captured.head.treeId);
      assertUnchanged(finalCapture.fingerprint === captured.fingerprint);

      const finalSnapshot = this.dependencies.extractReviewSnapshot({
        store: this.store,
        project: finalProject as Project,
        side: 'target',
        baseCommit: finalCapture.head.fullCommit,
        baseTreeId: finalCapture.head.treeId,
        workingTreeFingerprint: finalCapture.fingerprint,
        traceDeckVersion: this.dependencies.traceDeckVersion,
        extraInventory: [],
      });
      assertUnchanged(
        finalSnapshot.userConfigurationFingerprint === target.userConfigurationFingerprint,
      );
      assertUnchanged(
        finalSnapshot.effectiveBaselineFingerprint === target.effectiveBaselineFingerprint,
      );
      assertNotCancelled(lease);

      this.setPhase(projectId, lease, 'persisting', { message: 'Saving the completed review…' });
      const summary = {
        projectId,
        baseCommit: result.baseCommit,
        baseTreeId: result.baseTreeId,
        workingTreeFingerprint: result.workingTreeFingerprint,
        userConfigurationFingerprint: result.userConfigurationFingerprint,
        effectiveBaselineFingerprint: result.effectiveBaselineFingerprint,
        traceDeckVersion: this.dependencies.traceDeckVersion,
        resultSchemaVersion: result.schemaVersion,
        traversalDepth: result.traversalDepth,
        counts: result.counts,
        categoryAvailability: categoryAvailability(),
        limitations: result.limitations,
      } satisfies Omit<ChangeReviewSummary, 'reviewId' | 'completedAt'>;
      const record = this.store.changeReviews.replaceLatest({
        projectId,
        baseCommit: result.baseCommit,
        baseTreeId: result.baseTreeId,
        workingTreeFingerprint: result.workingTreeFingerprint,
        userConfigurationFingerprint: result.userConfigurationFingerprint,
        effectiveBaselineFingerprint: result.effectiveBaselineFingerprint,
        workingTreeScanId: result.workingTreeScanId,
        traceDeckVersion: this.dependencies.traceDeckVersion,
        resultSchemaVersion: result.schemaVersion,
        traversalDepth: result.traversalDepth,
        summary,
        result: result as ChangeReviewResult,
      });
      outcome = {
        operationId: lease.operationId,
        status: 'completed',
        code: null,
        message: 'Change review completed.',
      };
      return record;
    } catch (error) {
      const normalized = normalizeFailure(error, lease);
      outcome = terminalFor(normalized, lease.operationId);
      throw normalized;
    } finally {
      this.setPhase(projectId, lease, 'cleanup', { message: 'Cleaning up review workspace…' });
      if (baselineStore) {
        try {
          baselineStore.close();
        } catch {
          console.warn('Change review temporary database could not be closed cleanly.');
        }
      }
      if (temp) {
        try {
          const removed = await this.dependencies.removeVerifiedReviewTemp(temp.rootPath);
          if (!removed) console.warn('A verified change review workspace could not be removed.');
        } catch {
          console.warn('A verified change review workspace could not be removed.');
        }
      }
      this.setLastOutcome(projectId, outcome ?? {
        operationId: lease.operationId,
        status: 'failed',
        code: 'REVIEW_FAILED',
        message: 'The change review could not be completed.',
      });
      const active = this.activeStatuses.get(projectId);
      if (active?.operationId === lease.operationId) this.activeStatuses.delete(projectId);
      lease.release();
    }
  }
}

/** Constructs the production coordinator shared by Electron and the CLI. */
export function createChangeReviewCoordinator(
  store: DataStore,
  operations: ProjectOperationRegistry,
  traceDeckVersion: string,
): ChangeReviewCoordinator {
  return new ChangeReviewCoordinator(
    store,
    operations,
    defaultChangeReviewCoordinatorDependencies(traceDeckVersion),
  );
}
