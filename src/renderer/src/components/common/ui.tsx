import clsx from 'clsx';
import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import type { Severity } from '@shared/types';

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-[12px]',
        variant === 'primary' && 'border-brand bg-brand text-surface-0 hover:bg-brand/90',
        variant === 'default' && 'border-edge bg-surface-2 text-ink hover:bg-surface-3',
        variant === 'ghost' && 'border-transparent text-ink-muted hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'border-risk-crit/40 bg-transparent text-risk-crit hover:bg-risk-crit/10',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={clsx('rounded-lg border border-edge bg-surface-1', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-edge px-3.5 py-2.5">
          {title && (
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              {title}
            </h2>
          )}
          {actions}
        </header>
      )}
      <div className="p-3.5">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  value: number | string;
  tone?: 'neutral' | 'warn' | 'bad' | 'good';
  onClick?: () => void;
}): JSX.Element {
  const Element = onClick ? 'button' : 'div';
  return (
    <Element
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={clsx(
        'rounded-lg border border-edge bg-surface-1 p-3 text-left',
        onClick && 'transition-colors hover:border-brand/50 hover:bg-surface-2',
      )}
    >
      <div
        className={clsx(
          'font-mono text-xl font-semibold tabular-nums',
          tone === 'neutral' && 'text-ink',
          tone === 'good' && 'text-risk-low',
          tone === 'warn' && 'text-risk-med',
          tone === 'bad' && 'text-risk-high',
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] leading-tight text-ink-muted">{label}</div>
    </Element>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }): JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        severity === 'high' && 'bg-risk-crit/15 text-risk-crit',
        severity === 'medium' && 'bg-risk-high/15 text-risk-high',
        severity === 'low' && 'bg-risk-med/15 text-risk-med',
        severity === 'info' && 'bg-surface-3 text-ink-muted',
      )}
    >
      {severity}
    </span>
  );
}

export function RiskBadge({ score }: { score: number }): JSX.Element {
  const tone =
    score >= 75 ? 'text-risk-crit' : score >= 50 ? 'text-risk-high' : score >= 25 ? 'text-risk-med' : 'text-risk-low';
  return <span className={clsx('font-mono text-[12px] font-semibold tabular-nums', tone)}>{score}</span>;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <p className="max-w-md text-[12px] leading-relaxed text-ink-muted">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Used wherever the app must be explicit about what static analysis could not determine. */
export function Caveat({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
      <Info size={12} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function Warning({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-risk-med/30 bg-risk-med/10 px-2.5 py-2 text-[11px] leading-relaxed text-risk-med">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function PathLabel({
  path,
  className,
}: {
  path: string;
  className?: string;
}): JSX.Element {
  const separator = path.lastIndexOf('/');
  const directory = separator === -1 ? '' : path.slice(0, separator + 1);
  const name = separator === -1 ? path : path.slice(separator + 1);

  return (
    <span className={clsx('mono-path truncate', className)} title={path}>
      {directory && <span className="text-ink-faint">{directory}</span>}
      <span className="text-ink">{name}</span>
    </span>
  );
}

export function Spinner(): JSX.Element {
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-ink-faint border-t-transparent" />
  );
}
