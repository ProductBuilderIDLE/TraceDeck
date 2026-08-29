import type {
  ReviewDeltaDirection,
  ReviewFileChangeType,
  ReviewFilters as ReviewFiltersType,
  ReviewGitState,
  ReviewSection,
} from '@shared/changeReview';
import type { FindingType, Severity } from '@shared/types';
import { ALL_FINDING_TYPES } from '@shared/types';
import { Button, Caveat } from '../common/ui';

const APPLICABLE_FILTERS: Record<ReviewSection, readonly (keyof ReviewFiltersType)[]> = {
  files: ['changeTypes', 'gitStates', 'languages', 'folderPrefix'],
  edges: ['deltaDirections', 'languages', 'folderPrefix'],
  findings: ['deltaDirections', 'findingTypes', 'severities', 'languages', 'folderPrefix'],
  'architecture-violations': ['deltaDirections', 'severities', 'languages', 'folderPrefix'],
  cycles: ['deltaDirections', 'folderPrefix'],
  'reachable-exports': ['deltaDirections', 'languages', 'folderPrefix'],
  'affected-files': ['directness', 'languages', 'folderPrefix', 'minDepth', 'maxDepth'],
  'candidate-tests': ['directness', 'languages', 'folderPrefix', 'minDepth', 'maxDepth'],
  'no-known-tests': ['languages', 'folderPrefix'],
  limitations: [],
};

const DIRECTIONS_BY_SECTION: Record<ReviewSection, readonly ReviewDeltaDirection[]> = {
  files: [],
  edges: ['added', 'removed'],
  findings: ['introduced', 'resolved'],
  'architecture-violations': ['introduced', 'resolved'],
  cycles: ['added', 'removed'],
  'reachable-exports': ['added', 'removed'],
  'affected-files': [],
  'candidate-tests': [],
  'no-known-tests': [],
  limitations: [],
};

const FILE_CHANGE_TYPES: readonly ReviewFileChangeType[] = ['added', 'modified', 'deleted', 'renamed'];
const GIT_STATES: readonly ReviewGitState[] = ['staged', 'unstaged', 'untracked'];
const SEVERITIES: readonly Severity[] = ['info', 'low', 'medium', 'high'];
const DIRECTNESS = ['direct', 'indirect'] as const;

interface ReviewFiltersProps {
  section: ReviewSection;
  filters: ReviewFiltersType;
  onChange: (filters: ReviewFiltersType) => void;
}

function formatLabel(value: string): string {
  return value
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function ReviewFilters({ section, filters, onChange }: ReviewFiltersProps): JSX.Element {
  const applicable = new Set<keyof ReviewFiltersType>(APPLICABLE_FILTERS[section]);

  function update<K extends keyof ReviewFiltersType>(field: K, value: ReviewFiltersType[K]): void {
    onChange({ ...filters, [field]: value });
  }

  function toggleArrayValue<T extends string>(field: keyof ReviewFiltersType, value: T, current: T[]): void {
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    update(field, next as ReviewFiltersType[typeof field]);
  }

  function renderToggleGroup<T extends string>(
    label: string,
    field: keyof ReviewFiltersType,
    values: readonly T[],
    current: T[],
  ): JSX.Element | null {
    if (!applicable.has(field)) return null;
    return (
      <div key={field} className="space-y-1.5">
        <span className="text-[11px] font-medium text-ink-muted">{label}</span>
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => {
            const active = current.includes(value);
            return (
              <Button
                key={value}
                size="sm"
                variant={active ? 'primary' : 'default'}
                aria-pressed={active}
                onClick={() => toggleArrayValue(field, value, current)}
              >
                {formatLabel(value)}
              </Button>
            );
          })}
        </div>
      </div>
    );
  }

  const depthApplicable = applicable.has('minDepth') || applicable.has('maxDepth');

  return (
    <div className="space-y-3 rounded-lg border border-edge bg-surface-1 p-3.5" role="group" aria-label={`Filters for ${section}`}>
      {applicable.size === 0 && <Caveat>No filters can be applied to this section.</Caveat>}
      {renderToggleGroup('Change type', 'changeTypes', FILE_CHANGE_TYPES, filters.changeTypes)}
      {renderToggleGroup('Git state', 'gitStates', GIT_STATES, filters.gitStates)}
      {renderToggleGroup('Direction', 'deltaDirections', DIRECTIONS_BY_SECTION[section], filters.deltaDirections)}
      {renderToggleGroup('Finding type', 'findingTypes', ALL_FINDING_TYPES as readonly FindingType[], filters.findingTypes)}
      {renderToggleGroup('Severity', 'severities', SEVERITIES, filters.severities)}
      {renderToggleGroup('Directness', 'directness', DIRECTNESS, filters.directness as ('direct' | 'indirect')[])}
      {applicable.has('languages') && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-medium text-ink-muted">Language</span>
          <input
            type="text"
            value={filters.languages.join(', ')}
            onChange={(event) => {
              const next = event.target.value
                .split(/,\s*|\s+/)
                .map((item) => item.trim().toLowerCase())
                .filter((item) => item.length > 0);
              update('languages', next);
            }}
            placeholder="e.g. typescript, javascript"
            className="w-full rounded border border-edge bg-surface-0 px-2 py-1 text-[12px] text-ink"
          />
        </div>
      )}
      {applicable.has('folderPrefix') && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-medium text-ink-muted">Folder</span>
          <input
            type="text"
            value={filters.folderPrefix ?? ''}
            onChange={(event) => {
              const value = event.target.value.trim();
              update('folderPrefix', value.length > 0 ? value : null);
            }}
            placeholder="src/components"
            className="w-full rounded border border-edge bg-surface-0 px-2 py-1 text-[12px] text-ink"
          />
        </div>
      )}
      {depthApplicable && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-medium text-ink-muted">Depth</span>
          <div className="flex gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              Min
              <input
                type="number"
                min={0}
                value={filters.minDepth ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  update('minDepth', value === '' ? null : Math.max(0, Number(value)));
                }}
                className="w-16 rounded border border-edge bg-surface-0 px-2 py-1 text-[12px] text-ink"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              Max
              <input
                type="number"
                min={0}
                value={filters.maxDepth ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  update('maxDepth', value === '' ? null : Math.max(0, Number(value)));
                }}
                className="w-16 rounded border border-edge bg-surface-0 px-2 py-1 text-[12px] text-ink"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
