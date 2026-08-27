import { dbClient } from '@app/db/client';

interface ButtonProps {
  label: string;
}

export function Button({ label }: ButtonProps): JSX.Element {
  dbClient.query('select 1');
  return <button type="button">{label}</button>;
}

export function UnusedBadge(): JSX.Element {
  return <span>unused</span>;
}
