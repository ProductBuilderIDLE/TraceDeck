import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Copy, ExternalLink, FileCode, History, Pencil, Save, X } from 'lucide-react';
import type { PreviewFinding, SourceDocument, SourceUnavailableDocument } from '@shared/types';
import { lineMarksForFile, withLiveConflicts, type LineMark } from '@shared/sourceMarkers';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { invoke } from '../../lib/ipc';
import { Button, Spinner } from '../common/ui';
import { CodeChanges } from './CodeChanges';
import { SourceEditor } from './SourceEditor';

const UNAVAILABLE_TITLE: Record<SourceUnavailableDocument['reason'], string> = {
  binary: 'Binary file',
  'too-large': 'File too large to display',
  unreadable: 'File could not be read',
  symlink: 'Symbolic link',
  'unsupported-encoding': 'Unsupported text encoding',
};

/** Explains precisely why a file has no rendered text, rather than showing an empty pane. */
function UnavailableNotice({ doc }: { doc: SourceUnavailableDocument }): JSX.Element {
  return (
    <div className="space-y-2 p-4">
      <p className="text-[12px] font-medium text-ink">{UNAVAILABLE_TITLE[doc.reason]}</p>
      <p className="max-w-md text-[11px] leading-relaxed text-ink-muted">{doc.message}</p>
      {doc.sizeBytes > 0 && (
        <p className="mono-path text-ink-faint">{doc.sizeBytes.toLocaleString()} bytes on disk</p>
      )}
    </div>
  );
}

export function CodePanel(): JSX.Element {
  const project = useAppStore((state) => state.currentProject);
  const findings = useAppStore((state) => state.findings);
  const startScan = useAppStore((state) => state.startScan);
  const refreshAnalysis = useAppStore((state) => state.refreshAnalysis);
  const scanning = useAppStore((state) => state.scanning);
  const codePath = useUiStore((state) => state.codePath);
  const codeLine = useUiStore((state) => state.codeLine);
  const closeCode = useUiStore((state) => state.closeCode);
  const editorTabs = useUiStore((state) => state.editorTabs);
  const openCode = useUiStore((state) => state.openCode);
  const closeEditorTab = useUiStore((state) => state.closeEditorTab);
  const themeId = useUiStore((state) => state.theme);

  const [doc, setDoc] = useState<SourceDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Files open read-only. Editing is an explicit choice, so a stray keystroke in a viewer
  // can never modify the user's source.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [baseline, setBaseline] = useState('');
  const [showingChanges, setShowingChanges] = useState(false);
  const [preview, setPreview] = useState<PreviewFinding[]>([]);

  const currentText = editing ? draft : doc?.kind === 'text' ? doc.text : '';
  const dirty = editing && doc?.kind === 'text' && draft !== doc.text;

  const marks = useMemo(() => {
    if (!codePath) return new Map<number, LineMark>();
    return withLiveConflicts(lineMarksForFile(findings, codePath), currentText, codePath);
  }, [findings, codePath, currentText]);

  useEffect(() => {
    if (!project || !codePath) {
      setDoc(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    invoke('source:read', { projectId: project.id, relativePath: codePath })
      .then((result) => {
        if (cancelled) return;
        setDoc(result);
        // Switching files always returns to the locked view.
        setEditing(false);
        setConflict(false);
        setShowingChanges(false);
        const text = result.kind === 'text' ? result.text : '';
        setDraft(text);
        setBaseline(text);
      })
      .catch((failure: Error) => {
        if (!cancelled) {
          setDoc(null);
          setError(failure.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project, codePath]);

  useEffect(() => {
    if (!project || !codePath || !editing || !dirty) {
      setPreview([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      invoke('analysis:preview', { projectId: project.id, relativePath: codePath, text: draft })
        .then((findings) => {
          if (!cancelled) setPreview(findings);
        })
        .catch(() => {
          if (!cancelled) setPreview([]);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [project, codePath, editing, dirty, draft]);

  const copyPath = async (): Promise<void> => {
    if (!codePath) return;
    try {
      await navigator.clipboard.writeText(codePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy the path.');
    }
  };

  const openExternally = async (): Promise<void> => {
    if (!project || !codePath) return;
    try {
      await invoke('system:open-path', { projectId: project.id, relativePath: codePath });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not open the file.');
    }
  };

  const save = useCallback(async (): Promise<void> => {
    if (!project || !codePath || doc?.kind !== 'text' || !editing) return;
    setSaving(true);
    setError(null);

    try {
      const saved = await invoke('source:save', {
        projectId: project.id,
        relativePath: codePath,
        baseHash: doc.contentHash,
        text: draft,
      });
      setDoc(saved);
      setDraft(saved.kind === 'text' ? saved.text : draft);
      setConflict(false);
      setEditing(false);
      if (scanning) {
        void refreshAnalysis();
      } else {
        void startScan(false);
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'The file could not be saved.';
      setConflict(/changed on disk/i.test(message));
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [project, codePath, doc, draft, editing, scanning, refreshAnalysis, startScan]);

  const discard = (): void => {
    if (doc?.kind === 'text') setDraft(doc.text);
    setEditing(false);
    setConflict(false);
    setError(null);
  };

  const formatDraft = async (): Promise<void> => {
    if (!project || !codePath) return;
    try {
      const result = await invoke('source:format', {
        projectId: project.id,
        relativePath: codePath,
        text: currentText,
      });
      if (editing) setDraft(result.text);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not format the file.');
    }
  };

  const fileName = codePath?.split('/').pop() ?? '';
  const directory = codePath?.slice(0, codePath.length - fileName.length) ?? '';
  const hasSessionChanges = doc?.kind === 'text' && baseline !== currentText;
  const showEditor = Boolean(doc && doc.kind === 'text' && !showingChanges && codePath);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-edge bg-surface-1">
      {editorTabs.length > 0 && (
        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-edge px-1 py-0.5">
          {editorTabs.map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => openCode(path)}
              className={clsx(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
                path === codePath ? 'bg-surface-3 text-ink' : 'text-ink-faint hover:text-ink',
              )}
            >
              <span className="mono-path max-w-[9rem] truncate">{path.split('/').pop()}</span>
              <span
                role="presentation"
                onClick={(event) => {
                  event.stopPropagation();
                  closeEditorTab(path);
                }}
              >
                <X size={9} />
              </span>
            </button>
          ))}
        </div>
      )}
      <header className="flex shrink-0 items-center gap-1 border-b border-edge px-3 py-1.5">
        <FileCode size={13} className="shrink-0 text-ink-faint" />
        <span className="mono-path min-w-0 flex-1 truncate" title={codePath ?? ''}>
          <span className="text-ink-faint">{directory}</span>
          <span className="text-ink">{fileName}</span>
        </span>

        {loading && <Spinner />}

        {doc?.kind === 'text' && (
          <Button
            size="sm"
            variant={showingChanges ? 'primary' : 'ghost'}
            disabled={!hasSessionChanges && !showingChanges}
            onClick={() => setShowingChanges((open) => !open)}
            title="Show changes since this file was opened"
          >
            <History size={11} />
            Changes
          </Button>
        )}

        {doc?.kind === 'text' && doc.editable && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} title="Unlock">
            <Pencil size={11} />
          </Button>
        )}
        {editing && (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
              title="Save"
            >
              {saving ? <Spinner /> : <Save size={11} />}
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={discard} title="Discard">
              Discard
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void formatDraft()} title="Format with Prettier or EditorConfig">
              Format
            </Button>
          </>
        )}

        <Button size="sm" variant="ghost" onClick={() => void copyPath()} title="Copy path">
          <Copy size={11} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void openExternally()} title="Open with system default">
          <ExternalLink size={11} />
        </Button>
        <button
          type="button"
          onClick={() => {
            if (
              dirty &&
              !window.confirm('This file has unsaved changes. Close the viewer and lose them?')
            ) {
              return;
            }
            closeCode();
          }}
          className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
          aria-label="Close code viewer"
        >
          <X size={13} />
        </button>
      </header>

      {error && editing && (
        <div
          className={clsx(
            'shrink-0 border-b px-3 py-2 text-[11px] leading-relaxed',
            conflict ? 'border-risk-med/40 bg-risk-med/10 text-risk-med' : 'border-risk-crit/40 bg-risk-crit/10 text-risk-crit',
          )}
        >
          {error}
          {conflict && (
            <span className="mt-1 block text-ink-muted">
              Your edits are still here. Copy anything you need, then discard to reload the
              current file from disk.
            </span>
          )}
        </div>
      )}

      {copied && (
        <p className="shrink-0 border-b border-edge px-3 py-1 text-[10px] text-ink-faint">
          Path copied.
        </p>
      )}

      {editing && dirty && (
        <div className="shrink-0 border-b border-edge px-3 py-1.5 text-[11px] text-ink-muted">
          {preview.length === 0
            ? 'If you save now, this file’s scan findings stay as they are (conflicts, JSON, and unresolved imports are rechecked on this buffer).'
            : `If you save now: ${preview.length} finding(s) on this buffer — ${preview
                .slice(0, 3)
                .map((item) => item.title)
                .join('; ')}${preview.length > 3 ? '…' : ''}`}
        </div>
      )}

      <div className={clsx('min-h-0 flex-1', showEditor ? 'overflow-hidden' : 'overflow-auto')}>
        {!codePath ? (
          <p className="p-4 text-[11px] leading-relaxed text-ink-faint">
            Select a file in the graph or explorer to read its source here.
          </p>
        ) : error && !editing ? (
          <p className="p-4 text-[11px] leading-relaxed text-risk-crit">{error}</p>
        ) : showingChanges && doc?.kind === 'text' ? (
          <CodeChanges baseline={baseline} current={currentText} />
        ) : doc?.kind === 'unavailable' ? (
          <UnavailableNotice doc={doc} />
        ) : showEditor && codePath ? (
          <div className="flex h-full min-h-0 flex-col">
            <SourceEditor
              key={codePath}
              path={codePath}
              value={currentText}
              readOnly={!editing}
              marks={marks}
              revealLine={codeLine}
              themeId={themeId}
              tabSize={doc?.kind === 'text' ? doc.editorConfig?.indentSize : undefined}
              insertSpaces={doc?.kind === 'text' ? doc.editorConfig?.indentStyle !== 'tab' : undefined}
              onChange={setDraft}
              onSave={() => {
                if (dirty && !saving) void save();
              }}
            />
            {doc?.kind === 'text' && doc.truncated && (
              <p className="shrink-0 border-t border-edge px-3 py-2 text-[10px] text-ink-faint">
                Showing the first {doc.lines.length} of {doc.totalLines} lines. This file cannot be
                edited here, because saving a partial view would discard the rest.
              </p>
            )}
          </div>
        ) : (
          !loading && (
            <p className="p-4 text-[11px] text-ink-faint">This file could not be loaded.</p>
          )
        )}
      </div>
    </section>
  );
}
