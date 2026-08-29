import { randomUUID } from 'node:crypto';

export type ProjectOperationKind = 'scan' | 'review';

export interface ActiveProjectOperation {
  readonly projectId: number;
  readonly kind: ProjectOperationKind;
  readonly operationId: string;
  readonly cancellationRequested: boolean;
  readonly workingTreeDirty: boolean;
}

export interface ProjectOperationLease extends ActiveProjectOperation {
  readonly scanSignal: { cancelled: boolean };
  readonly abortController: AbortController;
  markWorkingTreeDirty(): void;
  consumeWatcherDirty(): boolean;
  release(): void;
}

interface ProjectOperationState {
  readonly projectId: number;
  readonly kind: ProjectOperationKind;
  readonly operationId: string;
  readonly scanSignal: { cancelled: boolean };
  readonly abortController: AbortController;
  workingTreeDirty: boolean;
}

function metadata(operation: ProjectOperationState): ActiveProjectOperation {
  return Object.freeze({
    projectId: operation.projectId,
    kind: operation.kind,
    operationId: operation.operationId,
    cancellationRequested:
      operation.scanSignal.cancelled || operation.abortController.signal.aborted,
    workingTreeDirty: operation.workingTreeDirty,
  });
}

/** Coordinates the single scan or review operation allowed to run for each project. */
export class ProjectOperationRegistry {
  readonly #active = new Map<number, ProjectOperationState>();
  readonly #deferredWatcherScans = new Map<number, () => void>();

  acquire(projectId: number, kind: ProjectOperationKind): ProjectOperationLease | null {
    if (this.#active.has(projectId)) return null;

    const operation: ProjectOperationState = {
      projectId,
      kind,
      operationId: randomUUID(),
      scanSignal: { cancelled: false },
      abortController: new AbortController(),
      workingTreeDirty: false,
    };
    this.#active.set(projectId, operation);

    const lease: ProjectOperationLease = {
      get projectId() {
        return operation.projectId;
      },
      get kind() {
        return operation.kind;
      },
      get operationId() {
        return operation.operationId;
      },
      get cancellationRequested() {
        return operation.scanSignal.cancelled || operation.abortController.signal.aborted;
      },
      get workingTreeDirty() {
        return operation.workingTreeDirty;
      },
      scanSignal: operation.scanSignal,
      abortController: operation.abortController,
      markWorkingTreeDirty: () => {
        if (this.#active.get(projectId) === operation) operation.workingTreeDirty = true;
      },
      consumeWatcherDirty: () => {
        if (this.#active.get(projectId) !== operation || !operation.workingTreeDirty) return false;
        operation.workingTreeDirty = false;
        return true;
      },
      release: () => {
        if (this.#active.get(projectId) !== operation) return;

        this.#active.delete(projectId);
        const deferredScan = this.#deferredWatcherScans.get(projectId);
        this.#deferredWatcherScans.delete(projectId);
        if (deferredScan) queueMicrotask(deferredScan);
      },
    };

    return Object.freeze(lease);
  }

  active(projectId: number): ActiveProjectOperation | null {
    const operation = this.#active.get(projectId);
    return operation ? metadata(operation) : null;
  }

  cancel(projectId: number, operationId?: string): boolean {
    const operation = this.#active.get(projectId);
    if (!operation || (operationId !== undefined && operation.operationId !== operationId)) {
      return false;
    }

    operation.scanSignal.cancelled = true;
    operation.abortController.abort();
    return true;
  }

  deferWatcherScan(projectId: number, callback: () => void): boolean {
    const operation = this.#active.get(projectId);
    if (operation?.kind !== 'review') return false;

    operation.workingTreeDirty = true;
    this.#deferredWatcherScans.set(projectId, callback);
    return true;
  }
}
