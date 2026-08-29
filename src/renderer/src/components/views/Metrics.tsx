import { useEffect, useState } from 'react';
import type { ChurnEntry, FileOutlier, FolderMetrics } from '@shared/types';
import { useAppStore } from '../../store/appStore';
import { invoke } from '../../lib/ipc';
import { Card, EmptyState, PathLabel, Spinner } from '../common/ui';

function Bar({ value, max, label }: { value: number; max: number; label: string }): JSX.Element {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-right font-mono text-[10px] text-ink-faint">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full bg-brand/70" style={{ width: `${width}%` }} />
      </div>
      <span className="w-8 shrink-0 font-mono text-[10px] tabular-nums text-ink-muted">{value}</span>
    </div>
  );
}

export function MetricsView(): JSX.Element {
  const project = useAppStore((state) => state.currentProject);
  const stats = useAppStore((state) => state.stats);
  const [folders, setFolders] = useState<FolderMetrics[]>([]);
  const [outliers, setOutliers] = useState<FileOutlier[]>([]);
  const [churn, setChurn] = useState<ChurnEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      invoke('analysis:folder-metrics', { projectId: project.id }),
      invoke('git:churn', { projectId: project.id }).catch(() => [] as ChurnEntry[]),
    ])
      .then(([metrics, gitChurn]) => {
        if (cancelled) return;
        if (Array.isArray(metrics)) {
          setFolders(metrics);
          setOutliers([]);
        } else {
          setFolders(metrics.folders ?? []);
          setOutliers(metrics.outliers ?? []);
        }
        setChurn(gitChurn ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setFolders([]);
        setOutliers([]);
        setChurn([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, stats]);

  if (!project || !stats) {
    return <EmptyState title="No metrics yet" description="Scan a project to compute folder and churn metrics." />;
  }

  const maxFan = Math.max(1, ...folders.map((row) => Math.max(row.afferent, row.efferent)));
  const maxChurn = Math.max(1, ...churn.map((entry) => entry.commits));

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-medium">Metrics</h2>
        {loading && <Spinner />}
      </div>
      <p className="text-[11px] leading-relaxed text-ink-muted">
        Folder instability is Ce / (Ca + Ce). Abstractness is the share of files that declare an
        interface or type. Bars are counts, not grades. Churn is Git history for the last 90 days
        when this folder is a repository.
      </p>
      <Card title="Fan-in / fan-out by folder">
        <div className="space-y-3">
          {folders.slice(0, 16).map((row) => (
            <div key={row.folder}>
              <PathLabel path={row.folder} className="mb-1 block" />
              <Bar value={row.afferent} max={maxFan} label="Ca" />
              <Bar value={row.efferent} max={maxFan} label="Ce" />
            </div>
          ))}
        </div>
      </Card>
      <Card title="Folder instability and abstractness">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-1 pr-3 font-medium">Folder</th>
                <th className="py-1 pr-3 font-medium">Files</th>
                <th className="py-1 pr-3 font-medium">Ca</th>
                <th className="py-1 pr-3 font-medium">Ce</th>
                <th className="py-1 pr-3 font-medium">I</th>
                <th className="py-1 font-medium">A</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((row) => (
                <tr key={row.folder} className="border-t border-edge">
                  <td className="py-1 pr-3"><PathLabel path={row.folder} /></td>
                  <td className="py-1 pr-3 font-mono">{row.fileCount}</td>
                  <td className="py-1 pr-3 font-mono">{row.afferent}</td>
                  <td className="py-1 pr-3 font-mono">{row.efferent}</td>
                  <td className="py-1 pr-3 font-mono">{row.instability.toFixed(2)}</td>
                  <td className="py-1 font-mono">{row.abstractness.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {outliers.length > 0 && (
        <Card title="File size and coupling outliers">
          <ul className="space-y-1">
            {outliers.slice(0, 20).map((entry) => (
              <li key={entry.relativePath} className="flex justify-between gap-3 text-[11px]">
                <PathLabel path={entry.relativePath} />
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                  {entry.sizeBytes.toLocaleString()} B · {entry.symbolCount} symbols · in {entry.fanIn} / out {entry.fanOut}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {churn.length > 0 && (
        <Card title="Git churn heatmap (90 days)">
          <ul className="space-y-1">
            {churn.slice(0, 30).map((entry) => (
              <li key={entry.relativePath} className="flex items-center gap-2">
                <div className="h-2 w-24 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full bg-risk-med/80"
                    style={{ width: `${Math.max(6, Math.round((entry.commits / maxChurn) * 100))}%` }}
                  />
                </div>
                <PathLabel path={entry.relativePath} className="min-w-0 flex-1" />
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                  {entry.commits} · +{entry.additions} −{entry.deletions}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
