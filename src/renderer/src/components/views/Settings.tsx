import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Check, Trash2 } from 'lucide-react';
import { ALWAYS_EXCLUDED_DIRS, PRIVACY_NOTICE } from '@shared/constants';
import { THEMES, THEME_IDS } from '@shared/theme';
import { useUiStore } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { invoke } from '../../lib/ipc';
import { Button, Caveat, Card } from '../common/ui';

function listToText(values: readonly string[]): string {
  return values.join('\n');
}

function textToList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}


function ThemePicker(): JSX.Element {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);

  return (
    <Card title="Appearance">
      <div className="grid grid-cols-2 gap-2.5">
        {THEME_IDS.map((id) => {
          const option = THEMES[id];
          const active = theme === id;

          return (
            <button
              key={id}
              type="button"
              onClick={() => setTheme(id)}
              aria-pressed={active}
              className={clsx(
                'rounded-lg border p-2.5 text-left transition-colors',
                active ? 'border-brand bg-brand/10' : 'border-edge bg-surface-2 hover:border-ink-faint',
              )}
            >
              {/* A miniature of the real layout, painted with that theme's own tokens. */}
              <span
                className="mb-2 flex h-11 overflow-hidden rounded border"
                style={{
                  borderColor: `rgb(${option.tokens.edge})`,
                  background: `rgb(${option.tokens['surface-0']})`,
                }}
              >
                <span
                  className="h-full w-1/3 border-r"
                  style={{
                    background: `rgb(${option.tokens['surface-1']})`,
                    borderColor: `rgb(${option.tokens.edge})`,
                  }}
                />
                <span className="flex flex-1 flex-col justify-center gap-1 px-1.5">
                  <span
                    className="h-1 w-3/4 rounded-full"
                    style={{ background: `rgb(${option.tokens.brand})` }}
                  />
                  <span
                    className="h-1 w-1/2 rounded-full"
                    style={{ background: `rgb(${option.tokens['ink-muted']})` }}
                  />
                  <span className="flex gap-1">
                    {(['risk-low', 'risk-med', 'risk-crit'] as const).map((token) => (
                      <span
                        key={token}
                        className="h-1 w-3 rounded-full"
                        style={{ background: `rgb(${option.tokens[token]})` }}
                      />
                    ))}
                  </span>
                </span>
              </span>

              <span className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-ink">{option.label}</span>
                {active && <Check size={12} className="shrink-0 text-brand" />}
              </span>
              <span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2.5 border-t border-edge pt-2.5">
        <Caveat>
          The editor themes are approximations built to sit comfortably next to those editors,
          not exact copies of them. Your choice is remembered on this device only.
        </Caveat>
      </div>
    </Card>
  );
}

export function SettingsView(): JSX.Element {
  const project = useAppStore((state) => state.currentProject);
  const projects = useAppStore((state) => state.projects);
  const updateConfiguration = useAppStore((state) => state.updateConfiguration);
  const removeProject = useAppStore((state) => state.removeProject);

  const [excludePatterns, setExcludePatterns] = useState('');
  const [entryPoints, setEntryPoints] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [respectGitignore, setRespectGitignore] = useState(true);
  const [includeTestFiles, setIncludeTestFiles] = useState(true);
  const [typeCheck, setTypeCheck] = useState(false);
  const [saved, setSaved] = useState(false);
  const [appInfo, setAppInfo] = useState<{
    version: string;
    electron: string;
    databasePath: string;
  } | null>(null);

  useEffect(() => {
    if (!project) return;
    setExcludePatterns(listToText(project.configuration.excludePatterns));
    setEntryPoints(listToText(project.configuration.entryPoints));
    setExclusions(listToText(project.configuration.unusedExportExclusions));
    setRespectGitignore(project.configuration.respectGitignore);
    setIncludeTestFiles(project.configuration.includeTestFiles);
    setTypeCheck(project.configuration.typeCheck);
  }, [project]);

  useEffect(() => {
    invoke('system:app-info', undefined)
      .then(setAppInfo)
      .catch(() => undefined);
  }, []);

  const save = async (): Promise<void> => {
    await updateConfiguration({
      excludePatterns: textToList(excludePatterns),
      entryPoints: textToList(entryPoints),
      unusedExportExclusions: textToList(exclusions),
      respectGitignore,
      includeTestFiles,
      typeCheck,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const textarea =
    'w-full rounded border border-edge bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none';

  if (!project) {
    return (
      <div className="space-y-4 p-5">
        <ThemePicker />
        <Card title="Scan settings">
          <p className="text-[12px] text-ink-muted">
            Open a project to configure how it is scanned.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-5">
      <ThemePicker />

      <Card title="Scan settings">
        <div className="space-y-3.5">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={respectGitignore}
              onChange={(event) => setRespectGitignore(event.target.checked)}
              className="mt-0.5 accent-brand"
            />
            <span>
              <span className="block text-[12px] text-ink">Respect .gitignore</span>
              <span className="block text-[11px] text-ink-faint">
                Skip files git would ignore, honouring nested .gitignore files.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={includeTestFiles}
              onChange={(event) => setIncludeTestFiles(event.target.checked)}
              className="mt-0.5 accent-brand"
            />
            <span>
              <span className="block text-[12px] text-ink">Include test files</span>
              <span className="block text-[11px] text-ink-faint">
                Test files count as dependents, which affects the change impact score.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={typeCheck}
              onChange={(event) => setTypeCheck(event.target.checked)}
              className="mt-0.5 accent-brand"
            />
            <span>
              <span className="block text-[12px] text-ink">
                Run the TypeScript type checker during a scan
              </span>
              <span className="block text-[11px] leading-relaxed text-ink-faint">
                Reports real compile errors from the TypeScript compiler, not TraceDeck&rsquo;s own
                analysis. This is the only check here that can tell you code is actually broken.
                It needs a tsconfig.json, and it is substantially slower than the import scan
                because it builds a full compiler program.
              </span>
            </span>
          </label>

          <div>
            <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="exclude">
              Additional exclude patterns (one per line)
            </label>
            <textarea
              id="exclude"
              rows={4}
              value={excludePatterns}
              onChange={(event) => setExcludePatterns(event.target.value)}
              placeholder={'src/generated/**\n**/*.stories.tsx'}
              className={textarea}
              style={{ userSelect: 'text' }}
            />
            <p className="mt-1 text-[10px] leading-snug text-ink-faint">
              Always excluded regardless of settings: {ALWAYS_EXCLUDED_DIRS.join(', ')}.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="entries">
              Public entry points (one relative path per line)
            </label>
            <textarea
              id="entries"
              rows={3}
              value={entryPoints}
              onChange={(event) => setEntryPoints(event.target.value)}
              placeholder={'src/index.ts\nsrc/cli.ts'}
              className={textarea}
              style={{ userSelect: 'text' }}
            />
            <p className="mt-1 text-[10px] leading-snug text-ink-faint">
              Exports from these files are never reported as unused. When left empty, entry points
              are inferred from package.json and from files nothing imports.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="exclusions">
              Unused-export exclusions (one per line)
            </label>
            <textarea
              id="exclusions"
              rows={3}
              value={exclusions}
              onChange={(event) => setExclusions(event.target.value)}
              placeholder={'src/public-api/**\nsrc/util.ts#keepThis'}
              className={textarea}
              style={{ userSelect: 'text' }}
            />
            <p className="mt-1 text-[10px] leading-snug text-ink-faint">
              Accepts a glob for whole files, or <span className="font-mono">path#symbol</span> for
              a single export.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void save()}>
              Save settings
            </Button>
            {saved && <span className="text-[11px] text-risk-low">Saved. Rescan to apply.</span>}
          </div>
        </div>
      </Card>

      <Card title="Privacy">
        <p className="text-[12px] leading-relaxed text-ink-muted">{PRIVACY_NOTICE}</p>
        <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-ink-faint">
          <li>· No network requests are made, and outbound requests are blocked at the session layer.</li>
          <li>· No telemetry, analytics, accounts, or sync of any kind.</li>
          <li>· Source code is read but never copied out of the project folder.</li>
          <li>· Analysis is stored in a local SQLite database outside your project.</li>
          <li>· Reports are written only where you choose in a save dialog.</li>
        </ul>
        {appInfo && (
          <dl className="mono-path selectable mt-3 space-y-1 border-t border-edge pt-2.5 text-ink-faint">
            <div className="flex gap-2">
              <dt className="w-20">version</dt>
              <dd>{appInfo.version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20">electron</dt>
              <dd>{appInfo.electron}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0">database</dt>
              <dd className="break-all">{appInfo.databasePath}</dd>
            </div>
          </dl>
        )}
      </Card>

      <Card title={`Known projects (${projects.length})`}>
        <ul className="divide-y divide-edge">
          {projects.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-ink">{entry.name}</span>
                <span className="mono-path block truncate text-ink-faint">{entry.rootPath}</span>
              </span>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void removeProject(entry.id)}
                title="Remove this project's analysis from TraceDeck"
              >
                <Trash2 size={11} />
                Forget
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-2.5 border-t border-edge pt-2.5">
          <Caveat>
            Forgetting a project deletes only TraceDeck&rsquo;s stored analysis for it. Your source
            files are never modified or deleted.
          </Caveat>
        </div>
      </Card>
    </div>
  );
}
