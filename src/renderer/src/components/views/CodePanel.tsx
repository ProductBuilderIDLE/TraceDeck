import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Copy, ExternalLink, FileCode, Pencil, Save, X } from 'lucide-react';
import type { SourceDocument, SourceTokenKind, SourceUnavailableDocument } from '@shared/types';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { invoke } from '../../lib/ipc';
import { Button, Spinner } from '../common/ui';

const TOKEN_CLASS: Record<SourceTokenKind, string> = {
  keyword: 'text-brand',
  string: 'text-risk-low',
  number: 'text-risk-med',
  comment: 'text-ink-faint italic',
  type: 'text-risk-high',
  identifier: 'text-ink',
  punctuation: 'text-ink-muted',
  plain: 'text-ink-muted',
};

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
  const codePath = useUiStore((state) => state.codePath);
  const codeLine = useUiStore((state) => state.codeLine);
  const closeCode = useUiStore((state) => state.closeCode);
  const refreshAfterEdit = useAppStore((state) => state.refreshAnalysis);

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

  const dirty = editing && doc?.kind === 'text' && draft !== doc.text;

  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

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
        setDraft(result.kind === 'text' ? result.text : '');
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

  // Bring the requested line into view once the document has rendered.
  useEffect(() => {
    if (!doc || codeLine === null) return;
    const target = lineRefs.current.get(codeLine);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [doc, codeLine]);

  const gutterWidth = useMemo(() => {
    const digits = String(doc?.kind === 'text' ? doc.lines.length : 1).length;
    return `${Math.max(2, digits)}ch`;
  }, [doc]);

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

  const save = async (): Promise<void> => {
    if (!project || !codePath || doc?.kind !== 'text') return;
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
      // Re-analyse so the graph reflects the edit that was just written.
      void refreshAfterEdit();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'The file could not be saved.';
      // The draft is deliberately kept on conflict so the user's work is never thrown away.
      setConflict(/changed on disk/i.test(message));
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const discard = (): void => {
    if (doc?.kind === 'text') setDraft(doc.text);
    setEditing(false);
    setConflict(false);
    setError(null);
  };

  const fileName = codePath?.split('/').pop() ?? '';
  const directory = codePath?.slice(0, codePath.length - fileName.length) ?? '';

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-edge bg-surface-1">
      <header className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
        <FileCode size={13} className="shrink-0 text-ink-faint" />
        <span className="mono-path min-w-0 flex-1 truncate" title={codePath ?? ''}>
          <span className="text-ink-faint">{directory}</span>
          <span className="text-ink">{fileName}</span>
        </span>

        {loading && <Spinner />}

        {doc?.kind === 'text' && doc.editable && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} title="Edit this file">
            <Pencil size={11} />
            Unlock
          </Button>
        )}
        {editing && (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? <Spinner /> : <Save size={11} />}
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={discard}>
              Discard changes
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {!codePath ? (
          <p className="p-4 text-[11px] leading-relaxed text-ink-faint">
            Select a file in the graph or explorer to read its source here.
          </p>
        ) : error && !editing ? (
          <p className="p-4 text-[11px] leading-relaxed text-risk-crit">{error}</p>
        ) : doc?.kind === 'unavailable' ? (
          <UnavailableNotice doc={doc} />
        ) : doc && editing ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            aria-label={`Edit ${codePath}`}
            className="selectable h-full w-full resize-none bg-surface-1 p-3 font-mono text-[11px] leading-[1.55] text-ink outline-none"
            style={{ userSelect: 'text' }}
          />
        ) : doc ? (
          <>
            <pre className="selectable w-max min-w-full py-1 font-mono text-[11px] leading-[1.55]">
              <code>
                {doc.lines.map((line) => (
                  <div
                    key={line.number}
                    ref={(element) => {
                      if (element) lineRefs.current.set(line.number, element);
                      else lineRefs.current.delete(line.number);
                    }}
                    className={clsx('flex px-0', line.number === codeLine && 'bg-brand/10')}
                  >
                    <span
                      className="sticky left-0 shrink-0 select-none bg-surface-1 pr-3 pl-3 text-right text-ink-faint"
                      style={{ width: `calc(${gutterWidth} + 1.5rem)` }}
                    >
                      {line.number}
                    </span>
                    <span className="whitespace-pre pr-4">
                      {line.spans.length === 0
                        ? ' '
                        : line.spans.map((span, index) => (
                            <span key={index} className={TOKEN_CLASS[span.kind]}>
                              {span.text}
                            </span>
                          ))}
                    </span>
                  </div>
                ))}
              </code>
            </pre>

            {doc.truncated && (
              <p className="border-t border-edge px-3 py-2 text-[10px] text-ink-faint">
                Showing the first {doc.lines.length} of {doc.totalLines} lines. This file cannot be
                edited here, because saving a partial view would discard the rest.
              </p>
            )}
          </>
        ) : (
          !loading && (
            <p className="p-4 text-[11px] text-ink-faint">This file could not be loaded.</p>
          )
        )}
      </div>
    </section>
  );
}
