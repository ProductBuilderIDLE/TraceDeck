import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a rendering failure in one view from blanking the whole window. Analysis data can be
 * unusual in ways no test anticipated, and losing the sidebar with it would leave the user
 * unable to rescan or switch projects.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] view crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[13px] font-medium text-ink">This view could not be displayed</p>
        <p className="max-w-md text-[11px] leading-relaxed text-ink-muted">{error.message}</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded-md border border-edge bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink hover:bg-surface-3"
        >
          Try again
        </button>
      </div>
    );
  }
}
