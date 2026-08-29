import clsx from 'clsx';
import type { ReviewWorkspaceTab } from '../../store/reviewStore';

const TABS: { id: ReviewWorkspaceTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'files-and-edges', label: 'Files and edges' },
  { id: 'findings', label: 'Findings' },
  { id: 'possible-impact', label: 'Possible impact' },
  { id: 'limitations', label: 'Limitations' },
];

export function ReviewTabs({
  selected,
  onSelect,
  disabled,
}: {
  selected: ReviewWorkspaceTab;
  onSelect: (tab: ReviewWorkspaceTab) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div role="tablist" aria-label="Review sections" className="flex gap-1 border-b border-edge px-4">
      {TABS.map((tab, index) => {
        const isSelected = tab.id === selected;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-posinset={index + 1}
            aria-setsize={TABS.length}
            tabIndex={isSelected ? 0 : -1}
            disabled={disabled}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                const nextIndex = event.key === 'ArrowRight'
                  ? (index + 1) % TABS.length
                  : (index - 1 + TABS.length) % TABS.length;
                onSelect(TABS[nextIndex]!.id);
              }
            }}
            className={clsx(
              'rounded-t-md border-b-2 px-3 py-2 text-[12px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
              isSelected
                ? 'border-brand text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
              disabled && 'cursor-not-allowed opacity-40',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
