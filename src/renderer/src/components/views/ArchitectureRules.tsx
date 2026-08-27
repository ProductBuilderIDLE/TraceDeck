import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Plus, Trash2 } from 'lucide-react';
import type { ArchitectureRule, Severity } from '@shared/types';
import { useAppStore } from '../../store/appStore';
import { Button, Caveat, EmptyState } from '../common/ui';
import { FindingsView } from './Findings';

const SEVERITIES: Severity[] = ['info', 'low', 'medium', 'high'];

const PRESETS: Array<{ name: string; source: string; target: string }> = [
  { name: 'UI must not reach the database', source: 'src/components/**', target: 'src/db/**' },
  { name: 'Domain must not depend on UI', source: 'src/domain/**', target: 'src/ui/**' },
  { name: 'Client must not import server code', source: 'src/client/**', target: 'src/server/**' },
];

interface Draft {
  id?: number;
  name: string;
  sourcePattern: string;
  targetPattern: string;
  severity: Severity;
  exceptions: string;
  enabled: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  sourcePattern: '',
  targetPattern: '',
  severity: 'medium',
  exceptions: '',
  enabled: true,
};

function RuleEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  error,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  error: string | null;
}): JSX.Element {
  const field = 'w-full rounded border border-edge bg-surface-2 px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none';

  return (
    <div className="space-y-2.5 rounded-lg border border-brand/40 bg-surface-1 p-3.5">
      <div>
        <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="rule-name">
          Rule name
        </label>
        <input
          id="rule-name"
          className={field}
          style={{ userSelect: 'text' }}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="Components must not import the database layer"
        />
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="rule-source">
            Files matching
          </label>
          <input
            id="rule-source"
            className={`${field} font-mono`}
            style={{ userSelect: 'text' }}
            value={draft.sourcePattern}
            onChange={(event) => onChange({ ...draft, sourcePattern: event.target.value })}
            placeholder="src/components/**"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="rule-target">
            Must not import
          </label>
          <input
            id="rule-target"
            className={`${field} font-mono`}
            style={{ userSelect: 'text' }}
            value={draft.targetPattern}
            onChange={(event) => onChange({ ...draft, targetPattern: event.target.value })}
            placeholder="src/db/**"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="rule-severity">
            Severity
          </label>
          <select
            id="rule-severity"
            className={field}
            value={draft.severity}
            onChange={(event) => onChange({ ...draft, severity: event.target.value as Severity })}
          >
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severity}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="rule-exceptions">
            Exceptions (comma separated)
          </label>
          <input
            id="rule-exceptions"
            className={`${field} font-mono`}
            style={{ userSelect: 'text' }}
            value={draft.exceptions}
            onChange={(event) => onChange({ ...draft, exceptions: event.target.value })}
            placeholder="src/components/admin/**"
          />
        </div>
      </div>

      <Caveat>
        Patterns use glob syntax: <span className="font-mono">**</span> matches any number of
        folders, <span className="font-mono">*</span> matches within one path segment. Paths are
        relative to the project root. Only resolved imports are checked.
      </Caveat>

      {error && <p className="text-[11px] text-risk-crit">{error}</p>}

      <div className="flex gap-1.5">
        <Button variant="primary" size="sm" onClick={onSave}>
          {draft.id ? 'Save changes' : 'Create rule'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ArchitectureRulesView(): JSX.Element {
  const project = useAppStore((state) => state.currentProject);
  const rules = useAppStore((state) => state.rules);
  const loadRules = useAppStore((state) => state.loadRules);
  const saveRule = useAppStore((state) => state.saveRule);
  const deleteRule = useAppStore((state) => state.deleteRule);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadRules();
  }, [loadRules, project]);

  const startEdit = (rule: ArchitectureRule): void => {
    setError(null);
    setDraft({
      id: rule.id,
      name: rule.name,
      sourcePattern: rule.sourcePattern,
      targetPattern: rule.targetPattern,
      severity: rule.configuration.severity,
      exceptions: rule.configuration.exceptions.join(', '),
      enabled: rule.enabled,
    });
  };

  const save = async (): Promise<void> => {
    if (!project || !draft) return;

    if (!draft.name.trim() || !draft.sourcePattern.trim() || !draft.targetPattern.trim()) {
      setError('Name, source pattern, and target pattern are all required.');
      return;
    }

    setError(null);
    await saveRule({
      ...(draft.id !== undefined ? { id: draft.id } : {}),
      projectId: project.id,
      name: draft.name.trim(),
      enabled: draft.enabled,
      ruleType: 'forbid-import',
      sourcePattern: draft.sourcePattern.trim(),
      targetPattern: draft.targetPattern.trim(),
      configuration: {
        severity: draft.severity,
        exceptions: draft.exceptions
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      },
    });

    const failure = useAppStore.getState().error;
    if (failure) {
      setError(failure);
      useAppStore.getState().setError(null);
      return;
    }

    setDraft(null);
  };

  const toggle = async (rule: ArchitectureRule): Promise<void> => {
    if (!project) return;
    await saveRule({
      id: rule.id,
      projectId: project.id,
      name: rule.name,
      enabled: !rule.enabled,
      ruleType: rule.ruleType,
      sourcePattern: rule.sourcePattern,
      targetPattern: rule.targetPattern,
      configuration: rule.configuration,
    });
  };

  if (!project) {
    return <EmptyState title="No project open" description="Open a project to define rules." />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="max-h-[55%] shrink-0 space-y-3 overflow-y-auto border-b border-edge p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[13px] font-medium text-ink">Architecture rules</h2>
            <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-ink-muted">
              Declare boundaries your codebase should respect. Each rule blocks imports from files
              matching one pattern to files matching another, and is evaluated against resolved
              imports from the last scan.
            </p>
          </div>
          {!draft && (
            <Button size="sm" variant="primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              <Plus size={11} />
              New rule
            </Button>
          )}
        </div>

        {draft && (
          <RuleEditor
            draft={draft}
            onChange={setDraft}
            onSave={() => void save()}
            onCancel={() => {
              setDraft(null);
              setError(null);
            }}
            error={error}
          />
        )}

        {rules.length === 0 && !draft ? (
          <div className="space-y-2 rounded-lg border border-edge bg-surface-1 p-3.5">
            <p className="text-[12px] text-ink-muted">
              No rules yet. Start from a common boundary:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.name}
                  size="sm"
                  onClick={() =>
                    setDraft({
                      ...EMPTY_DRAFT,
                      name: preset.name,
                      sourcePattern: preset.source,
                      targetPattern: preset.target,
                    })
                  }
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className={clsx(
                  'flex items-center gap-3 rounded-lg border border-edge bg-surface-1 px-3 py-2.5',
                  !rule.enabled && 'opacity-50',
                )}
              >
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() => void toggle(rule)}
                  className="shrink-0 accent-brand"
                  aria-label={`Enable ${rule.name}`}
                />
                <button
                  type="button"
                  onClick={() => startEdit(rule)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-[12px] text-ink">{rule.name}</span>
                  <span className="mono-path block truncate text-ink-faint">
                    {rule.sourcePattern} ⇸ {rule.targetPattern}
                  </span>
                </button>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
                  {rule.configuration.severity}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void deleteRule(rule.id)}
                  title="Delete rule"
                >
                  <Trash2 size={11} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <FindingsView
          findingType="architecture-violation"
          title="Violations"
          description="Imports from the last scan that break an enabled rule."
          emptyTitle="No violations"
          emptyDescription="No resolved import in the last scan breaks an enabled architecture rule."
        />
      </div>
    </div>
  );
}
