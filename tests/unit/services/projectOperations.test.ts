import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOperationRegistry } from '@main/services/projectOperations';

describe('ProjectOperationRegistry', () => {
  it('excludes concurrent operations for one project while keeping projects independent', () => {
    const registry = new ProjectOperationRegistry();
    const first = registry.acquire(1, 'scan');
    const otherProject = registry.acquire(2, 'review');

    expect(first).not.toBeNull();
    expect(registry.acquire(1, 'scan')).toBeNull();
    expect(registry.acquire(1, 'review')).toBeNull();
    expect(otherProject).not.toBeNull();
    expect(registry.active(1)).toMatchObject({ projectId: 1, kind: 'scan' });
    expect(registry.active(2)).toMatchObject({ projectId: 2, kind: 'review' });
  });

  it('uses immutable UUID operation identity', () => {
    const lease = new ProjectOperationRegistry().acquire(7, 'review');

    expect(lease).not.toBeNull();
    expect(lease?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(Reflect.set(lease!, 'projectId', 9)).toBe(false);
    expect(Reflect.set(lease!, 'kind', 'scan')).toBe(false);
    expect(Reflect.set(lease!, 'operationId', randomUUID())).toBe(false);
    expect(lease).toMatchObject({ projectId: 7, kind: 'review' });
  });

  it('cancels only a matching operation ID and signals both scan and Git work', () => {
    const registry = new ProjectOperationRegistry();
    const lease = registry.acquire(1, 'scan');

    expect(lease).not.toBeNull();
    expect(registry.cancel(1, randomUUID())).toBe(false);
    expect(lease?.scanSignal.cancelled).toBe(false);
    expect(lease?.abortController.signal.aborted).toBe(false);

    expect(registry.cancel(1, lease?.operationId)).toBe(true);
    expect(lease?.scanSignal.cancelled).toBe(true);
    expect(lease?.abortController.signal.aborted).toBe(true);
    expect(lease?.cancellationRequested).toBe(true);
    expect(registry.active(1)?.cancellationRequested).toBe(true);

    const oldOperationId = lease?.operationId;
    lease?.release();
    const newerLease = registry.acquire(1, 'review');
    expect(registry.cancel(1, oldOperationId)).toBe(false);
    expect(newerLease?.scanSignal.cancelled).toBe(false);
    expect(newerLease?.abortController.signal.aborted).toBe(false);
  });

  it('releases idempotently without allowing a stale lease to clear newer work', () => {
    const registry = new ProjectOperationRegistry();
    const oldLease = registry.acquire(1, 'scan');

    oldLease?.release();
    const newerLease = registry.acquire(1, 'review');
    oldLease?.release();

    expect(newerLease).not.toBeNull();
    expect(registry.active(1)?.operationId).toBe(newerLease?.operationId);
    newerLease?.release();
    newerLease?.release();
    expect(registry.active(1)).toBeNull();
  });

  it('marks watcher dirtiness and consumes it exactly once', () => {
    const registry = new ProjectOperationRegistry();
    const lease = registry.acquire(1, 'review');

    expect(lease?.workingTreeDirty).toBe(false);
    lease?.markWorkingTreeDirty();
    expect(lease?.workingTreeDirty).toBe(true);
    expect(registry.active(1)?.workingTreeDirty).toBe(true);
    expect(lease?.consumeWatcherDirty()).toBe(true);
    expect(lease?.workingTreeDirty).toBe(false);
    expect(lease?.consumeWatcherDirty()).toBe(false);
  });

  it('coalesces deferred watcher scans and runs one after release can reacquire', async () => {
    const registry = new ProjectOperationRegistry();
    const review = registry.acquire(1, 'review');
    const superseded = vi.fn();
    let deferredLease = null as ReturnType<ProjectOperationRegistry['acquire']>;
    const latest = vi.fn(() => {
      deferredLease = registry.acquire(1, 'scan');
    });

    expect(registry.deferWatcherScan(1, superseded)).toBe(true);
    expect(registry.deferWatcherScan(1, latest)).toBe(true);
    expect(review?.workingTreeDirty).toBe(true);

    review?.release();
    expect(registry.active(1)).toBeNull();
    expect(superseded).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(superseded).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(deferredLease).not.toBeNull();
    expect(registry.active(1)).toMatchObject({ kind: 'scan' });
  });

  it('does not defer watcher work behind an active scan', () => {
    const registry = new ProjectOperationRegistry();
    registry.acquire(1, 'scan');

    expect(registry.deferWatcherScan(1, vi.fn())).toBe(false);
  });
});
