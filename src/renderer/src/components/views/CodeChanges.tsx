import { useState } from 'react';
import { diffHunks, hunkSummary, type DiffHunk } from '@shared/lineDiff';

function LineBlock({
  lines,
  tone,
}: {
  lines: readonly string[];
  tone: 'old' | 'new';
}): JSX.Element | null {
  if (lines.length === 0) return null;
  const isOld = tone === 'old';

  return (
    <pre
      className={
        isOld
          ? 'selectable overflow-x-auto border border-risk-crit/30 bg-risk-crit/10 p-2 font-mono text-[11px] leading-[1.55] text-risk-crit'
          : 'selectable overflow-x-auto border border-risk-low/30 bg-risk-low/10 p-2 font-mono text-[11px] leading-[1.55] text-risk-low'
      }
    >
      {lines.map((line, index) => (
        <div key={`${tone}-${index}`} className="whitespace-pre">
          <span className="select-none pr-2 text-ink-faint">{isOld ? '−' : '+'}</span>
          {line.length === 0 ? ' ' : line}
        </div>
      ))}
    </pre>
  );
}

function HunkDetail({ hunk }: { hunk: DiffHunk }): JSX.Element {
  return (
    <div className="space-y-2">
      <LineBlock lines={hunk.oldLines} tone="old" />
      <LineBlock lines={hunk.newLines} tone="new" />
    </div>
  );
}

export function CodeChanges({
  baseline,
  current,
}: {
  baseline: string;
  current: string;
}): JSX.Element {
  const hunks = diffHunks(baseline, current);
  const [selected, setSelected] = useState(0);
  const hunk = hunks[selected] ?? hunks[0] ?? null;

  if (hunks.length === 0) {
    return (
      <p className="p-4 text-[11px] leading-relaxed text-ink-faint">
        No changes since this file was opened.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="max-h-40 shrink-0 overflow-auto border-b border-edge">
        {hunks.map((entry, index) => (
          <li key={`${entry.oldStart}-${entry.newStart}-${index}`}>
            <button
              type="button"
              onClick={() => setSelected(index)}
              className={
                index === selected
                  ? 'flex w-full px-3 py-1.5 text-left font-mono text-[11px] bg-surface-2 text-ink'
                  : 'flex w-full px-3 py-1.5 text-left font-mono text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink'
              }
            >
              {hunkSummary(entry)}
            </button>
          </li>
        ))}
      </ul>
      <div className="min-h-0 flex-1 overflow-auto p-3">{hunk && <HunkDetail hunk={hunk} />}</div>
    </div>
  );
}
