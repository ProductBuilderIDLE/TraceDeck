import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Copy, ExternalLink, FileCode, X } from 'lucide-react';
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

  const [doc, setDoc] = useState<SourceDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
        if (!cancelled) setDoc(result);
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
        <Button size="sm" variant="ghost" onClick={() => void copyPath()} title="Copy path">
          <Copy size={11} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void openExternally()} title="Open with system default">
          <ExternalLink size={11} />
        </Button>
        <button
          type="button"
          onClick={closeCode}
          className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
          aria-label="Close code viewer"
        >
          <X size={13} />
        </button>
      </header>

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
        ) : error ? (
          <p className="p-4 text-[11px] leading-relaxed text-risk-crit">{error}</p>
        ) : doc?.kind === 'unavailable' ? (
          <UnavailableNotice doc={doc} />
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
